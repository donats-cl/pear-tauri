//! Discord Rich Presence: «Слушает …» в профиле Discord.
//!
//! IPC с Discord блокирующий, поэтому всё общение — в отдельном потоке.
//! Команды из страницы только кладут желаемое состояние в канал; поток
//! сворачивает очередь до последнего значения, не шлёт чаще MIN_INTERVAL
//! и переподключается, если Discord закрыт или перезапущен.

use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant};

use discord_rich_presence::activity::{
    Activity, ActivityType, Assets, Button, StatusDisplayType, Timestamps,
};
use discord_rich_presence::{DiscordIpc, DiscordIpcClient};
use serde::Deserialize;
use tauri::State;

// Discord-приложение Pear Desktop (pear-devs/pear-desktop, src/plugins/discord/constants.ts)
const CLIENT_ID: &str = "1177081335727267940";

const MIN_INTERVAL: Duration = Duration::from_secs(1);
const RETRY_INTERVAL: Duration = Duration::from_secs(15);

// Ограничения Discord на поля активности
const MAX_TEXT_CHARS: usize = 128;
const MAX_IMAGE_URL_LEN: usize = 256;
// Discord отклоняет строки короче 2 символов — добиваем невидимым символом
const FILLER: char = '\u{3164}';

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Presence {
    title: String,
    artist: String,
    album: Option<String>,
    art_url: Option<String>,
    video_id: Option<String>,
    /// Unix-время начала трека, мс
    start_ms: Option<i64>,
    /// Unix-время конца трека, мс
    end_ms: Option<i64>,
    paused: bool,
}

pub struct DiscordRpc(Sender<Option<Presence>>);

impl DiscordRpc {
    pub fn spawn() -> Self {
        let (tx, rx) = mpsc::channel();
        thread::Builder::new()
            .name("discord-rpc".into())
            .spawn(move || run(rx))
            .expect("failed to spawn discord-rpc thread");
        Self(tx)
    }

    fn send(&self, presence: Option<Presence>) -> Result<(), String> {
        self.0.send(presence).map_err(|_| "discord-rpc thread stopped".into())
    }
}

#[tauri::command]
pub fn discord_set_activity(rpc: State<'_, DiscordRpc>, presence: Presence) -> Result<(), String> {
    rpc.send(Some(presence))
}

#[tauri::command]
pub fn discord_clear_activity(rpc: State<'_, DiscordRpc>) -> Result<(), String> {
    rpc.send(None)
}

/* ------------------------------------------------------------------ *
 *  Поток IPC
 * ------------------------------------------------------------------ */
fn run(rx: Receiver<Option<Presence>>) {
    let mut client: Option<DiscordIpcClient> = None;
    let mut wanted: Option<Presence> = None;
    let mut dirty = false;
    let mut next_attempt = Instant::now();

    loop {
        // Duration::MAX — просто ждём следующее сообщение
        let timeout = if dirty {
            next_attempt.saturating_duration_since(Instant::now())
        } else {
            Duration::MAX
        };
        match rx.recv_timeout(timeout) {
            Ok(p) => {
                wanted = p;
                dirty = true;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        // нужна только последняя версия состояния
        while let Ok(p) = rx.try_recv() {
            wanted = p;
            dirty = true;
        }
        if !dirty || Instant::now() < next_attempt {
            continue;
        }

        match push(&mut client, wanted.as_ref()) {
            Ok(()) => {
                dirty = false;
                next_attempt = Instant::now() + MIN_INTERVAL;
            }
            Err(e) => {
                // Discord не запущен или соединение оборвалось — повторим позже
                eprintln!("[Pear] Discord RPC: {e}");
                if let Some(mut c) = client.take() {
                    let _ = c.close();
                }
                next_attempt = Instant::now() + RETRY_INTERVAL;
            }
        }
    }

    if let Some(mut c) = client {
        let _ = c.clear_activity();
        let _ = c.close();
    }
}

fn push(client: &mut Option<DiscordIpcClient>, presence: Option<&Presence>) -> Result<(), String> {
    let Some(presence) = presence else {
        // нечего показывать: если не подключены, то и чистить нечего
        if let Some(c) = client.as_mut() {
            c.clear_activity().map_err(|e| e.to_string())?;
            read_reply(c)?;
        }
        return Ok(());
    };

    let c = match client {
        Some(c) => c,
        None => {
            let mut c = DiscordIpcClient::new(CLIENT_ID);
            c.connect().map_err(|e| e.to_string())?;
            client.insert(c)
        }
    };
    c.set_activity(build_activity(presence))
        .map_err(|e| e.to_string())?;
    read_reply(c)
}

// Discord отвечает на каждую команду; ответы нужно вычитывать, иначе забьётся канал.
// Ошибка в ответе — это проблема с данными, а не с соединением: только логируем.
fn read_reply(c: &mut DiscordIpcClient) -> Result<(), String> {
    let (_, reply) = c.recv().map_err(|e| e.to_string())?;
    if reply["evt"] == "ERROR" {
        eprintln!("[Pear] Discord RPC: Discord rejected activity: {}", reply["data"]);
    }
    Ok(())
}

/* ------------------------------------------------------------------ *
 *  Активность
 * ------------------------------------------------------------------ */
fn fit(s: &str) -> String {
    let mut out: String = s.trim().chars().take(MAX_TEXT_CHARS).collect();
    while out.chars().count() < 2 {
        out.push(FILLER);
    }
    out
}

fn is_video_id(id: &str) -> bool {
    id.len() == 11
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn build_activity(p: &Presence) -> Activity<'static> {
    let state = if p.paused {
        format!("⏸ {}", p.artist.trim())
    } else {
        p.artist.clone()
    };

    let mut activity = Activity::new()
        .activity_type(ActivityType::Listening)
        // в списке участников — «Слушает <название трека>»
        .status_display_type(StatusDisplayType::Details)
        .details(fit(&p.title))
        .state(fit(&state));

    // ссылку собираем сами, чтобы страница не могла подставить в профиль произвольный URL
    if let Some(id) = p.video_id.as_deref().filter(|id| is_video_id(id)) {
        let url = format!("https://music.youtube.com/watch?v={id}");
        activity = activity
            .details_url(url.clone())
            .buttons(vec![Button::new("Слушать в YouTube Music", url)]);
    }

    let mut assets = Assets::new();
    let mut has_assets = false;
    if let Some(art) = p
        .art_url
        .as_deref()
        .filter(|u| u.starts_with("https://") && u.len() <= MAX_IMAGE_URL_LEN)
    {
        assets = assets.large_image(art.to_owned());
        has_assets = true;
    }
    if let Some(album) = p.album.as_deref().filter(|a| !a.trim().is_empty()) {
        assets = assets.large_text(fit(album));
        has_assets = true;
    }
    if has_assets {
        activity = activity.assets(assets);
    }

    if !p.paused {
        if let Some(start) = p.start_ms {
            let mut ts = Timestamps::new().start(start);
            if let Some(end) = p.end_ms.filter(|&end| end > start) {
                ts = ts.end(end);
            }
            activity = activity.timestamps(ts);
        }
    }

    activity
}
