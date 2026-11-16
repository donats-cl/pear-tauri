//! История прослушиваний в SQLite (`<app data>/history.sqlite3`).
//!
//! Формат рассчитан на сотни тысяч прослушиваний:
//! - `tracks` — один трек = одна песня: клип (OMV) и аудиоверсия (ATV)
//!   сливаются в одну запись по нормализованному ключу «исполнитель|название»
//!   и по известным связям videoId;
//! - `track_videos` — все videoId трека (песня, клип) → трек;
//! - `plays` — одно прослушивание = одна узкая строка (≈40 байт), поэтому
//!   миллион прослушиваний занимает десятки мегабайт;
//! - счётчики и «топ» считаются запросами по индексам, а не хранятся отдельно.
//!
//! WAL-журнал: запись прослушивания не блокирует чтение страницы истории,
//! а данные не теряются при аварийном закрытии.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

const MAX_TEXT: usize = 512;
const MAX_PAGE: u32 = 500;

pub struct History(Mutex<Connection>);

impl History {
    pub fn open(dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let conn = Connection::open(dir.join("history.sqlite3")).map_err(|e| e.to_string())?;
        migrate(&conn).map_err(|e| e.to_string())?;
        Ok(Self(Mutex::new(conn)))
    }

    fn with<T>(&self, f: impl FnOnce(&mut Connection) -> rusqlite::Result<T>) -> Result<T, String> {
        let mut conn = self.0.lock().map_err(|_| "history db poisoned".to_string())?;
        f(&mut conn).map_err(|e| e.to_string())
    }
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;",
    )?;
    let version: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version < 1 {
        conn.execute_batch(
            "BEGIN;
             CREATE TABLE tracks (
                 id            INTEGER PRIMARY KEY,
                 track_key     TEXT    NOT NULL UNIQUE,
                 title         TEXT    NOT NULL,
                 artist        TEXT    NOT NULL,
                 album         TEXT    NOT NULL DEFAULT '',
                 cover_url     TEXT    NOT NULL DEFAULT '',
                 -- нормализованный текст для поиска (SQLite LIKE не знает кириллицу)
                 search        TEXT    NOT NULL DEFAULT '',
                 song_video_id TEXT,
                 clip_video_id TEXT,
                 duration_ms   INTEGER NOT NULL DEFAULT 0,
                 -- итоги по прослушиваниям: ведутся триггерами, чтобы «топ за всё
                 -- время» и статистика не пересчитывали миллион строк
                 play_count    INTEGER NOT NULL DEFAULT 0,
                 total_ms      INTEGER NOT NULL DEFAULT 0,
                 last_played   INTEGER NOT NULL DEFAULT 0
             );
             CREATE INDEX tracks_top ON tracks(play_count DESC, last_played DESC);
             CREATE TABLE track_videos (
                 video_id TEXT    PRIMARY KEY,
                 track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE
             ) WITHOUT ROWID;
             CREATE TABLE plays (
                 id         INTEGER PRIMARY KEY,
                 track_id   INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
                 is_video   INTEGER NOT NULL, -- клип (1) или песня (0)
                 started_at INTEGER NOT NULL, -- unix, мс
                 played_ms  INTEGER NOT NULL
             );
             CREATE INDEX plays_started ON plays(started_at);
             CREATE INDEX plays_track   ON plays(track_id, started_at);
             CREATE TRIGGER plays_ai AFTER INSERT ON plays BEGIN
                 UPDATE tracks SET play_count = play_count + 1,
                                   total_ms = total_ms + NEW.played_ms,
                                   last_played = MAX(last_played, NEW.started_at)
                 WHERE id = NEW.track_id;
             END;
             CREATE TRIGGER plays_au AFTER UPDATE OF played_ms ON plays BEGIN
                 UPDATE tracks SET total_ms = total_ms + NEW.played_ms - OLD.played_ms
                 WHERE id = NEW.track_id;
             END;
             CREATE TRIGGER plays_ad AFTER DELETE ON plays BEGIN
                 UPDATE tracks SET play_count = play_count - 1,
                                   total_ms = total_ms - OLD.played_ms,
                                   last_played = COALESCE((SELECT MAX(started_at) FROM plays WHERE track_id = OLD.track_id), 0)
                 WHERE id = OLD.track_id;
             END;
             PRAGMA user_version = 1;
             COMMIT;",
        )?;
    }
    // новые версии схемы — следующими блоками `if version < N`
    Ok(())
}

fn clip(s: &str) -> String {
    s.trim().chars().take(MAX_TEXT).collect()
}

fn is_video_id(id: &str) -> bool {
    id.len() == 11
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/* ------------------------------------------------------------------ *
 *  Запись прослушиваний
 * ------------------------------------------------------------------ */
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayStart {
    /// нормализованный «исполнитель|название» — общий для песни и клипа
    key: String,
    title: String,
    artist: String,
    album: String,
    cover_url: String,
    search: String,
    video_id: String,
    /// парная версия (клип для песни или песня для клипа), если известна
    counterpart_id: Option<String>,
    is_video: bool,
    duration_ms: i64,
    started_at: i64,
    played_ms: i64,
}

/// Находит трек по videoId (своему или парному), затем по ключу; иначе создаёт.
fn resolve_track(tx: &rusqlite::Transaction, p: &PlayStart, counterpart: Option<&str>) -> rusqlite::Result<i64> {
    let mut found: Option<i64> = None;
    for vid in std::iter::once(p.video_id.as_str()).chain(counterpart) {
        found = tx
            .query_row("SELECT track_id FROM track_videos WHERE video_id = ?1", [vid], |r| r.get(0))
            .optional()?;
        if found.is_some() {
            break;
        }
    }
    if found.is_none() {
        found = tx
            .query_row("SELECT id FROM tracks WHERE track_key = ?1", [&p.key], |r| r.get(0))
            .optional()?;
    }

    let id = match found {
        Some(id) => {
            // метаданные песни (ATV) точнее клиповых — клип только дополняет пустое
            if p.is_video {
                tx.execute(
                    "UPDATE tracks SET
                         album     = CASE WHEN album = '' THEN ?2 ELSE album END,
                         cover_url = CASE WHEN cover_url = '' THEN ?3 ELSE cover_url END
                     WHERE id = ?1",
                    params![id, p.album, p.cover_url],
                )?;
            } else {
                tx.execute(
                    "UPDATE tracks SET title = ?2, artist = ?3,
                         album = CASE WHEN ?4 = '' THEN album ELSE ?4 END,
                         cover_url = CASE WHEN ?5 = '' THEN cover_url ELSE ?5 END,
                         search = ?6
                     WHERE id = ?1",
                    params![id, p.title, p.artist, p.album, p.cover_url, p.search],
                )?;
            }
            id
        }
        None => {
            tx.execute(
                "INSERT INTO tracks (track_key, title, artist, album, cover_url, search, duration_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![p.key, p.title, p.artist, p.album, p.cover_url, p.search, p.duration_ms],
            )?;
            tx.last_insert_rowid()
        }
    };

    let (song, clip_id) = if p.is_video {
        (counterpart, Some(p.video_id.as_str()))
    } else {
        (Some(p.video_id.as_str()), counterpart)
    };
    tx.execute(
        "UPDATE tracks SET
             song_video_id = COALESCE(?2, song_video_id),
             clip_video_id = COALESCE(?3, clip_video_id),
             duration_ms   = CASE WHEN ?4 = 0 THEN duration_ms WHEN ?5 THEN duration_ms ELSE ?4 END
         WHERE id = ?1",
        // длительность берём у песни: у клипа бывают вступления и титры
        params![id, song, clip_id, p.duration_ms, p.is_video],
    )?;
    for vid in std::iter::once(p.video_id.as_str()).chain(counterpart) {
        tx.execute(
            "INSERT OR IGNORE INTO track_videos (video_id, track_id) VALUES (?1, ?2)",
            params![vid, id],
        )?;
    }
    Ok(id)
}

/// Записывает новое прослушивание; возвращает его id для `history_progress`.
#[tauri::command]
pub async fn history_start(db: State<'_, History>, play: PlayStart) -> Result<i64, String> {
    if !is_video_id(&play.video_id) {
        return Err("bad videoId".into());
    }
    let play = PlayStart {
        key: clip(&play.key),
        title: clip(&play.title),
        artist: clip(&play.artist),
        album: clip(&play.album),
        cover_url: clip(&play.cover_url),
        search: clip(&play.search),
        ..play
    };
    if play.key.is_empty() || play.title.is_empty() {
        return Err("empty track".into());
    }
    db.with(|conn| record_play(conn, &play))
}

fn record_play(conn: &mut Connection, play: &PlayStart) -> rusqlite::Result<i64> {
    let counterpart = play
        .counterpart_id
        .as_deref()
        .filter(|c| is_video_id(c) && *c != play.video_id);
    let tx = conn.transaction()?;
    let track_id = resolve_track(&tx, play, counterpart)?;
    tx.execute(
        "INSERT INTO plays (track_id, is_video, started_at, played_ms) VALUES (?1, ?2, ?3, ?4)",
        params![track_id, play.is_video, play.started_at, play.played_ms.max(0)],
    )?;
    let id = tx.last_insert_rowid();
    tx.commit()?;
    Ok(id)
}

/// Обновляет прослушанное время (растёт, пока трек играет).
#[tauri::command]
pub async fn history_progress(db: State<'_, History>, play_id: i64, played_ms: i64) -> Result<(), String> {
    db.with(|conn| {
        conn.execute(
            "UPDATE plays SET played_ms = MAX(played_ms, ?2) WHERE id = ?1",
            params![play_id, played_ms],
        )
        .map(|_| ())
    })
}

#[tauri::command]
pub async fn history_delete(db: State<'_, History>, play_id: i64) -> Result<(), String> {
    db.with(|conn| {
        let tx = conn.transaction()?;
        let track_id: Option<i64> = tx
            .query_row("SELECT track_id FROM plays WHERE id = ?1", [play_id], |r| r.get(0))
            .optional()?;
        tx.execute("DELETE FROM plays WHERE id = ?1", [play_id])?;
        // трек без прослушиваний больше не нужен (track_videos удалятся каскадом)
        if let Some(t) = track_id {
            tx.execute(
                "DELETE FROM tracks WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM plays WHERE track_id = ?1)",
                [t],
            )?;
        }
        tx.commit()
    })
}

/* ------------------------------------------------------------------ *
 *  Чтение
 * ------------------------------------------------------------------ */
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackRow {
    id: i64,
    title: String,
    artist: String,
    album: String,
    cover_url: String,
    song_video_id: Option<String>,
    clip_video_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayRow {
    id: i64,
    started_at: i64,
    played_ms: i64,
    is_video: bool,
    track: TrackRow,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopRow {
    plays: i64,
    total_ms: i64,
    last_played: i64,
    track: TrackRow,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    plays: i64,
    tracks: i64,
    total_ms: i64,
    first_played: Option<i64>,
}

const TRACK_COLS: &str = "t.id, t.title, t.artist, t.album, t.cover_url, t.song_video_id, t.clip_video_id";

fn track_at(r: &rusqlite::Row, i: usize) -> rusqlite::Result<TrackRow> {
    Ok(TrackRow {
        id: r.get(i)?,
        title: r.get(i + 1)?,
        artist: r.get(i + 2)?,
        album: r.get(i + 3)?,
        cover_url: r.get(i + 4)?,
        song_video_id: r.get(i + 5)?,
        clip_video_id: r.get(i + 6)?,
    })
}

/// Поиск по подстроке нормализованного текста; `%`, `_` экранируются.
fn like_pattern(search: Option<&str>) -> String {
    let s = search.unwrap_or("").trim();
    let escaped: String = s
        .chars()
        .take(MAX_TEXT)
        .flat_map(|c| match c {
            '%' | '_' | '\\' => vec!['\\', c],
            _ => vec![c],
        })
        .collect();
    format!("%{escaped}%")
}

/// Лента прослушиваний, новые сверху. Постранично: `before` — id последней
/// показанной строки (keyset-пагинация не замедляется на глубоких страницах).
#[tauri::command]
pub async fn history_list(
    db: State<'_, History>,
    before: Option<i64>,
    limit: u32,
    search: Option<String>,
) -> Result<Vec<PlayRow>, String> {
    db.with(|conn| list_plays(conn, before, limit, search.as_deref()))
}

fn list_plays(conn: &Connection, before: Option<i64>, limit: u32, search: Option<&str>) -> rusqlite::Result<Vec<PlayRow>> {
    let limit = limit.clamp(1, MAX_PAGE);
    let before = before.unwrap_or(i64::MAX);
    let map = |r: &rusqlite::Row| {
        Ok(PlayRow {
            id: r.get(0)?,
            started_at: r.get(1)?,
            played_ms: r.get(2)?,
            is_video: r.get(3)?,
            track: track_at(r, 4)?,
        })
    };
    let cols = format!("p.id, p.started_at, p.played_ms, p.is_video, {TRACK_COLS}");
    if search.is_none_or(|s| s.trim().is_empty()) {
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT {cols} FROM plays p JOIN tracks t ON t.id = p.track_id
             WHERE p.id < ?1 ORDER BY p.id DESC LIMIT ?2"
        ))?;
        let rows = stmt.query_map(params![before, limit], map)?;
        return rows.collect();
    }
    // при поиске сначала подходящие треки (их немного), потом их прослушивания
    // по индексу plays_track — а не перебор всей ленты (CROSS JOIN в SQLite
    // фиксирует порядок: сначала tracks, иначе планировщик идёт по plays)
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT {cols} FROM tracks t CROSS JOIN plays p ON p.track_id = t.id
         WHERE t.search LIKE ?1 ESCAPE '\\' AND p.id < ?2
         ORDER BY p.id DESC LIMIT ?3"
    ))?;
    let rows = stmt.query_map(params![like_pattern(search), before, limit], map)?;
    rows.collect()
}

/// Самые прослушиваемые треки (клип и песня вместе) с `since` (unix, мс).
#[tauri::command]
pub async fn history_top(
    db: State<'_, History>,
    since: Option<i64>,
    limit: u32,
    offset: u32,
    search: Option<String>,
) -> Result<Vec<TopRow>, String> {
    db.with(|conn| top_tracks(conn, since, limit, offset, search.as_deref()))
}

fn top_tracks(
    conn: &Connection,
    since: Option<i64>,
    limit: u32,
    offset: u32,
    search: Option<&str>,
) -> rusqlite::Result<Vec<TopRow>> {
    let limit = limit.clamp(1, MAX_PAGE);
    let pattern = like_pattern(search);
    let map = |r: &rusqlite::Row| {
        Ok(TopRow {
            plays: r.get(0)?,
            total_ms: r.get(1)?,
            last_played: r.get(2)?,
            track: track_at(r, 3)?,
        })
    };
    let rows = match since.filter(|s| *s > 0) {
        // за всё время — готовые итоги трека по индексу tracks_top
        None => {
            let mut stmt = conn.prepare_cached(&format!(
                "SELECT t.play_count, t.total_ms, t.last_played, {TRACK_COLS} FROM tracks t
                 WHERE t.play_count > 0 AND t.search LIKE ?1 ESCAPE '\\'
                 ORDER BY t.play_count DESC, t.last_played DESC LIMIT ?2 OFFSET ?3"
            ))?;
            let rows = stmt.query_map(params![pattern, limit, offset], map)?;
            rows.collect()
        }
        // за период — только прослушивания периода по индексу plays_started
        Some(since) => {
            let mut stmt = conn.prepare_cached(&format!(
                "SELECT COUNT(*) AS n, SUM(p.played_ms), MAX(p.started_at), {TRACK_COLS}
                 FROM plays p JOIN tracks t ON t.id = p.track_id
                 WHERE p.started_at >= ?1 AND t.search LIKE ?2 ESCAPE '\\'
                 GROUP BY t.id ORDER BY n DESC, MAX(p.started_at) DESC LIMIT ?3 OFFSET ?4"
            ))?;
            let rows = stmt.query_map(params![since, pattern, limit, offset], map)?;
            rows.collect()
        }
    };
    rows
}

#[tauri::command]
pub async fn history_stats(db: State<'_, History>) -> Result<Stats, String> {
    db.with(|conn| stats(conn))
}

fn stats(conn: &Connection) -> rusqlite::Result<Stats> {
    let (plays, tracks, total_ms) = conn.query_row(
        "SELECT COALESCE(SUM(play_count), 0), COUNT(*), COALESCE(SUM(total_ms), 0) FROM tracks WHERE play_count > 0",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let first_played = conn.query_row("SELECT MIN(started_at) FROM plays", [], |r| r.get(0))?;
    Ok(Stats { plays, tracks, total_ms, first_played })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn
    }

    fn play(key: &str, title: &str, video_id: &str, is_video: bool, counterpart: Option<&str>) -> PlayStart {
        PlayStart {
            key: key.into(),
            title: title.into(),
            artist: "Rick Astley".into(),
            album: if is_video { String::new() } else { "Whenever You Need Somebody".into() },
            cover_url: String::new(),
            search: title.to_lowercase(),
            video_id: video_id.into(),
            counterpart_id: counterpart.map(Into::into),
            is_video,
            duration_ms: if is_video { 212_000 } else { 213_000 },
            started_at: 1,
            played_ms: 60_000,
        }
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn song_and_clip_with_same_key_are_one_track() {
        let mut conn = db();
        record_play(&mut conn, &play("rick astley|never gonna give you up", "Never Gonna Give You Up", "aaaaaaaaaaa", false, None)).unwrap();
        record_play(&mut conn, &play("rick astley|never gonna give you up", "Never Gonna Give You Up", "dQw4w9WgXcQ", true, None)).unwrap();
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM tracks"), 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM plays"), 2);
        let (song, clip, album, dur): (String, String, String, i64) = conn
            .query_row("SELECT song_video_id, clip_video_id, album, duration_ms FROM tracks", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .unwrap();
        assert_eq!((song.as_str(), clip.as_str()), ("aaaaaaaaaaa", "dQw4w9WgXcQ"));
        assert_eq!(album, "Whenever You Need Somebody"); // клип не затёр альбом песни
        assert_eq!(dur, 213_000); // длительность песни, не клипа
    }

    #[test]
    fn counterpart_link_merges_even_with_different_titles() {
        let mut conn = db();
        record_play(&mut conn, &play("rick astley|never gonna give you up", "Never Gonna Give You Up", "aaaaaaaaaaa", false, Some("dQw4w9WgXcQ"))).unwrap();
        // у клипа другое название, но YouTube Music указал его парную песню
        record_play(&mut conn, &play("rick astley|never gonna give you up official video", "Never Gonna Give You Up (Official Video)", "dQw4w9WgXcQ", true, None)).unwrap();
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM tracks"), 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM track_videos"), 2);
    }

    #[test]
    fn delete_last_play_removes_track() {
        let mut conn = db();
        let id = record_play(&mut conn, &play("a|b", "B", "aaaaaaaaaaa", false, None)).unwrap();
        let tx = conn.transaction().unwrap();
        tx.execute("DELETE FROM plays WHERE id = ?1", [id]).unwrap();
        tx.execute("DELETE FROM tracks WHERE NOT EXISTS (SELECT 1 FROM plays WHERE track_id = tracks.id)", []).unwrap();
        tx.commit().unwrap();
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM track_videos"), 0); // каскад
    }

    #[test]
    fn like_pattern_escapes_wildcards() {
        assert_eq!(like_pattern(Some("50%_off")), r"%50\%\_off%");
        assert_eq!(like_pattern(None), "%%");
    }
    /// Замер на большой истории: `cargo test --release -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bench_million_plays() {
        let dir = std::env::temp_dir().join(format!("pear-history-bench-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let history = History::open(&dir).unwrap();
        let mut conn = history.0.lock().unwrap();
        let t = std::time::Instant::now();
        {
            let tx = conn.transaction().unwrap();
            for i in 0..50_000i64 {
                tx.execute(
                    "INSERT INTO tracks (track_key, title, artist, search) VALUES (?1, ?2, ?3, ?4)",
                    params![format!("artist {}|title {i}", i % 3000), format!("Title {i}"), format!("Artist {}", i % 3000), format!("title {i} artist {}", i % 3000)],
                )
                .unwrap();
            }
            let mut stmt = tx
                .prepare("INSERT INTO plays (track_id, is_video, started_at, played_ms) VALUES (?1, 0, ?2, 180000)")
                .unwrap();
            for i in 0..1_000_000i64 {
                // популярные треки слушают чаще
                let track = 1 + (i * i % 50_000) % 50_000;
                stmt.execute(params![track, 1_600_000_000_000 + i * 60_000]).unwrap();
            }
            drop(stmt);
            tx.commit().unwrap();
        }
        println!("insert 1M plays: {:?}", t.elapsed());
        drop(conn);
        let size = std::fs::metadata(dir.join("history.sqlite3")).unwrap().len()
            + std::fs::metadata(dir.join("history.sqlite3-wal")).map(|m| m.len()).unwrap_or(0);
        println!("db size: {:.1} MB", size as f64 / 1e6);

        let conn = history.0.lock().unwrap();
        let time = |name: &str, f: &dyn Fn(&Connection) -> usize, conn: &Connection| {
            let t = std::time::Instant::now();
            let n = f(conn);
            println!("{name}: {n} rows in {:?}", t.elapsed());
        };
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
        time("list first page", &|c| list_plays(c, None, 100, None).unwrap().len(), &conn);
        time("list deep page", &|c| list_plays(c, Some(1000), 100, None).unwrap().len(), &conn);
        time("list search (rare)", &|c| list_plays(c, None, 100, Some("title 4242 ")).unwrap().len(), &conn);
        time("list search (popular)", &|c| list_plays(c, None, 100, Some("artist 7")).unwrap().len(), &conn);
        time("top all time", &|c| top_tracks(c, None, 100, 0, None).unwrap().len(), &conn);
        time("top all time search", &|c| top_tracks(c, None, 100, 0, Some("artist 7")).unwrap().len(), &conn);
        time("top 30 days", &|c| top_tracks(c, Some(1_600_000_000_000 + 970_000 * 60_000), 100, 0, None).unwrap().len(), &conn);
        let t = std::time::Instant::now();
        let st = stats(&conn).unwrap();
        println!("stats: {} plays, {:?}", st.plays, t.elapsed());
        let size = std::fs::metadata(dir.join("history.sqlite3")).unwrap().len();
        println!("db size after checkpoint: {:.1} MB", size as f64 / 1e6);
        drop(conn);
        drop(history);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
