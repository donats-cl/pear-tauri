use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

mod discord_rpc;
mod history;
mod lyrics_cmd;

/// На телефоне — User-Agent десктопного Chrome: иначе YouTube Music отдаёт
/// урезанную мобильную веб-версию (без наших доработок), а Google чаще
/// блокирует вход в аккаунт внутри WebView.
#[cfg(mobile)]
const MOBILE_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            lyrics_cmd::http_get,
            discord_rpc::discord_set_activity,
            discord_rpc::discord_clear_activity,
            history::history_start,
            history::history_progress,
            history::history_delete,
            history::history_list,
            history::history_top,
            history::history_stats,
        ])
        .setup(|app| {
            app.manage(discord_rpc::DiscordRpc::spawn());
            app.manage(history::History::open(&app.path().app_data_dir()?)?);

            let builder = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External("https://music.youtube.com".parse().unwrap()),
            )
            .initialization_script(include_str!("../../inject/dist/inject.iife.js"));

            #[cfg(desktop)]
            {
                let main_window = builder.title("Pear").inner_size(1200.0, 800.0).build()?;
                main_window.set_zoom(1.2)?;
            }
            #[cfg(mobile)]
            builder.user_agent(MOBILE_USER_AGENT).build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
