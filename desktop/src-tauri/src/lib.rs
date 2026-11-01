mod inference;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .manage(inference::InferState::default())
        .invoke_handler(tauri::generate_handler![
            inference::infer_hardware,
            inference::infer_settings,
            inference::infer_set_model_dir,
            inference::infer_cancel,
            inference::infer_runtime_path,
            inference::infer_install_runtime,
            inference::infer_models_status,
            inference::infer_download_model,
            inference::infer_delete_model,
            inference::infer_start,
            inference::infer_stop,
            inference::infer_status,
            inference::infer_node_secret,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // never leave a model server running after the app quits
            if let tauri::RunEvent::Exit = event {
                inference::stop_child(&app.state::<inference::InferState>());
            }
        });
}
