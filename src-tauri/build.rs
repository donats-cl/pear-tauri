fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "http_get",
            "discord_set_activity",
            "discord_clear_activity",
            "history_start",
            "history_progress",
            "history_delete",
            "history_list",
            "history_top",
            "history_stats",
        ])),
    )
    .expect("failed to run tauri-build");
}
