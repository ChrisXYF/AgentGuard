use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Emitter, Manager, Window, WindowEvent, Wry};

use crate::runtime_activity::RuntimeSecurityAlertRecord;

pub const DESKTOP_SHELL_PREFERENCES_UPDATED_EVENT: &str = "desktop-shell-preferences-updated";
pub const DESKTOP_SHELL_OPEN_VIEW_REQUEST_EVENT: &str = "desktop-shell-open-view-request";
pub const RUNTIME_RISK_FOCUS_REQUEST_EVENT: &str = "runtime-risk-focus-request";
pub const RUNTIME_RISK_INBOX_UPDATED_EVENT: &str = "runtime-risk-inbox-updated";

const DESKTOP_SHELL_PREFERENCES_FILE: &str = "desktop-shell-preferences.json";
const MENU_SHOW_MAIN: &str = "desktop-shell.show-main";
const MENU_VIEW_RECENT_RISK: &str = "desktop-shell.view-recent-risk";
const MENU_OPEN_RUNTIME: &str = "desktop-shell.open-runtime";
const MENU_TOGGLE_SYSTEM_NOTIFICATIONS: &str = "desktop-shell.toggle-system-notifications";
const MENU_TOGGLE_FOREGROUND_RISK_CARD: &str = "desktop-shell.toggle-foreground-risk-card";
const MENU_TOGGLE_HIDE_TO_MENU_BAR: &str = "desktop-shell.toggle-hide-to-menu-bar";
const MENU_OPEN_SETTINGS: &str = "desktop-shell.open-settings";
const MENU_QUIT: &str = "desktop-shell.quit";
const TRAY_ID: &str = "desktop-shell-tray";

type DesktopMenuItem = MenuItem<Wry>;
type DesktopCheckMenuItem = CheckMenuItem<Wry>;
type DesktopTrayIcon = TrayIcon<Wry>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopShellPreferences {
    pub enable_system_notifications: bool,
    pub enable_foreground_risk_card: bool,
    pub hide_to_menu_bar_on_close: bool,
}

impl Default for DesktopShellPreferences {
    fn default() -> Self {
        Self {
            enable_system_notifications: true,
            enable_foreground_risk_card: true,
            hide_to_menu_bar_on_close: true,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRiskInboxState {
    pub latest_alert: Option<RuntimeSecurityAlertRecord>,
    pub pending_count: usize,
    pub latest_pending_alert_id: Option<i64>,
    pub last_seen_alert_id: Option<i64>,
}

impl RuntimeRiskInboxState {
    pub fn bootstrap_with_existing_alerts(
        &mut self,
        existing_alerts: &[RuntimeSecurityAlertRecord],
    ) {
        if self.latest_alert.is_some() {
            return;
        }
        if let Some(latest) = existing_alerts.first().cloned() {
            self.latest_alert = Some(latest.clone());
            self.last_seen_alert_id = Some(latest.id);
            self.pending_count = 0;
            self.latest_pending_alert_id = None;
        }
    }

    pub fn ingest_fresh_alerts(&mut self, fresh_alerts: &[RuntimeSecurityAlertRecord]) {
        if fresh_alerts.is_empty() {
            return;
        }

        let mut sorted = fresh_alerts.to_vec();
        sorted.sort_by_key(|alert| alert.id);

        for alert in sorted {
            let should_increment = self
                .last_seen_alert_id
                .map(|last_seen_id| alert.id > last_seen_id)
                .unwrap_or(true);
            self.latest_alert = Some(alert.clone());
            if should_increment {
                self.pending_count += 1;
                self.latest_pending_alert_id = Some(alert.id);
            }
        }
    }

    pub fn mark_seen(&mut self) {
        if let Some(latest_alert) = self.latest_alert.as_ref() {
            self.last_seen_alert_id = Some(latest_alert.id);
        }
        self.pending_count = 0;
        self.latest_pending_alert_id = None;
    }

    pub fn latest_focus_request(&self) -> Option<RuntimeRiskFocusRequest> {
        let alert = self.latest_alert.as_ref()?;
        Some(RuntimeRiskFocusRequest::from_alert(alert))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRiskFocusRequest {
    pub request_id: String,
    pub session_id: String,
    pub alert_id: i64,
    pub tab: String,
}

impl RuntimeRiskFocusRequest {
    pub fn from_alert(alert: &RuntimeSecurityAlertRecord) -> Self {
        Self {
            request_id: format!("risk-focus-{}", alert.id),
            session_id: alert.session_id.clone(),
            alert_id: alert.id,
            tab: if alert.blocked {
                "blocked".to_string()
            } else {
                "alerts".to_string()
            },
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopShellOpenViewRequest {
    pub view: String,
}

struct DesktopShellTrayHandles {
    tray: DesktopTrayIcon,
    view_recent_risk: DesktopMenuItem,
    system_notifications: DesktopCheckMenuItem,
    foreground_risk_card: DesktopCheckMenuItem,
    hide_to_menu_bar: DesktopCheckMenuItem,
}

pub struct DesktopShellState {
    preferences_path: PathBuf,
    preferences: Mutex<DesktopShellPreferences>,
    risk_inbox: Mutex<RuntimeRiskInboxState>,
    quit_requested: AtomicBool,
    tray: Mutex<Option<DesktopShellTrayHandles>>,
}

impl DesktopShellState {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let preferences_path = resolve_preferences_path(app)?;
        let preferences = load_preferences(&preferences_path)?;
        Ok(Self {
            preferences_path,
            preferences: Mutex::new(preferences),
            risk_inbox: Mutex::new(RuntimeRiskInboxState::default()),
            quit_requested: AtomicBool::new(false),
            tray: Mutex::new(None),
        })
    }

    pub fn initialize_tray(&self, app: &AppHandle) -> Result<(), String> {
        let show_main = MenuItem::with_id(app, MENU_SHOW_MAIN, "显示主窗口", true, None::<&str>)
            .map_err(|error| error.to_string())?;
        let view_recent_risk = MenuItem::with_id(
            app,
            MENU_VIEW_RECENT_RISK,
            "查看最近风险（0）",
            false,
            None::<&str>,
        )
        .map_err(|error| error.to_string())?;
        let open_runtime =
            MenuItem::with_id(app, MENU_OPEN_RUNTIME, "打开运行时监控", true, None::<&str>)
                .map_err(|error| error.to_string())?;
        let system_notifications = CheckMenuItem::with_id(
            app,
            MENU_TOGGLE_SYSTEM_NOTIFICATIONS,
            "系统通知",
            true,
            true,
            None::<&str>,
        )
        .map_err(|error| error.to_string())?;
        let foreground_risk_card = CheckMenuItem::with_id(
            app,
            MENU_TOGGLE_FOREGROUND_RISK_CARD,
            "前台风险卡",
            true,
            true,
            None::<&str>,
        )
        .map_err(|error| error.to_string())?;
        let hide_to_menu_bar = CheckMenuItem::with_id(
            app,
            MENU_TOGGLE_HIDE_TO_MENU_BAR,
            "关闭窗口隐藏到菜单栏",
            true,
            true,
            None::<&str>,
        )
        .map_err(|error| error.to_string())?;
        let open_settings =
            MenuItem::with_id(app, MENU_OPEN_SETTINGS, "打开设置", true, None::<&str>)
                .map_err(|error| error.to_string())?;
        let quit = MenuItem::with_id(app, MENU_QUIT, "退出", true, None::<&str>)
            .map_err(|error| error.to_string())?;

        let separator_one =
            PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?;
        let separator_two =
            PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?;

        let menu = Menu::with_items(
            app,
            &[
                &show_main,
                &view_recent_risk,
                &open_runtime,
                &separator_one,
                &system_notifications,
                &foreground_risk_card,
                &hide_to_menu_bar,
                &separator_two,
                &open_settings,
                &quit,
            ],
        )
        .map_err(|error| error.to_string())?;

        let tray = TrayIconBuilder::with_id(TRAY_ID)
            .menu(&menu)
            .tooltip("Aegis 正在后台运行")
            .show_menu_on_left_click(true)
            .icon(load_menu_bar_icon(false)?)
            .icon_as_template(true)
            .build(app)
            .map_err(|error| error.to_string())?;

        let handles = DesktopShellTrayHandles {
            tray,
            view_recent_risk,
            system_notifications,
            foreground_risk_card,
            hide_to_menu_bar,
        };

        if let Ok(mut tray_slot) = self.tray.lock() {
            *tray_slot = Some(handles);
        }

        self.refresh_tray(app)
    }

    pub fn get_preferences(&self) -> Result<DesktopShellPreferences, String> {
        self.preferences
            .lock()
            .map(|preferences| preferences.clone())
            .map_err(|_| "desktop shell preferences state is poisoned".to_string())
    }

    pub fn set_preferences(
        &self,
        app: &AppHandle,
        preferences: DesktopShellPreferences,
    ) -> Result<DesktopShellPreferences, String> {
        save_preferences(&self.preferences_path, &preferences)?;
        {
            let mut slot = self
                .preferences
                .lock()
                .map_err(|_| "desktop shell preferences state is poisoned".to_string())?;
            *slot = preferences.clone();
        }
        self.refresh_tray(app)?;
        emit_main_window(app, DESKTOP_SHELL_PREFERENCES_UPDATED_EVENT, &preferences)?;
        Ok(preferences)
    }

    pub fn get_risk_inbox(&self) -> Result<RuntimeRiskInboxState, String> {
        self.risk_inbox
            .lock()
            .map(|inbox| inbox.clone())
            .map_err(|_| "runtime risk inbox state is poisoned".to_string())
    }

    pub fn bootstrap_risk_inbox(
        &self,
        app: &AppHandle,
        existing_alerts: &[RuntimeSecurityAlertRecord],
    ) -> Result<(), String> {
        {
            let mut inbox = self
                .risk_inbox
                .lock()
                .map_err(|_| "runtime risk inbox state is poisoned".to_string())?;
            inbox.bootstrap_with_existing_alerts(existing_alerts);
        }
        self.refresh_tray(app)
    }

    pub fn ingest_fresh_risk_alerts(
        &self,
        app: &AppHandle,
        fresh_alerts: &[RuntimeSecurityAlertRecord],
    ) -> Result<RuntimeRiskInboxState, String> {
        let snapshot = {
            let mut inbox = self
                .risk_inbox
                .lock()
                .map_err(|_| "runtime risk inbox state is poisoned".to_string())?;
            inbox.ingest_fresh_alerts(fresh_alerts);
            inbox.clone()
        };

        self.refresh_tray(app)?;
        emit_main_window(app, RUNTIME_RISK_INBOX_UPDATED_EVENT, &snapshot)?;
        Ok(snapshot)
    }

    pub fn mark_risk_inbox_seen(&self, app: &AppHandle) -> Result<RuntimeRiskInboxState, String> {
        let snapshot = {
            let mut inbox = self
                .risk_inbox
                .lock()
                .map_err(|_| "runtime risk inbox state is poisoned".to_string())?;
            inbox.mark_seen();
            inbox.clone()
        };
        self.refresh_tray(app)?;
        emit_main_window(app, RUNTIME_RISK_INBOX_UPDATED_EVENT, &snapshot)?;
        Ok(snapshot)
    }

    pub fn open_recent_risk_details(&self, app: &AppHandle) -> Result<(), String> {
        let focus_request = self
            .get_risk_inbox()?
            .latest_focus_request()
            .ok_or_else(|| "no runtime risk is available".to_string())?;
        let _ = self.mark_risk_inbox_seen(app)?;
        show_main_window(app)?;
        emit_main_window(app, RUNTIME_RISK_FOCUS_REQUEST_EVENT, &focus_request)
    }

    pub fn open_runtime_view(&self, app: &AppHandle) -> Result<(), String> {
        show_main_window(app)?;
        emit_main_window(
            app,
            DESKTOP_SHELL_OPEN_VIEW_REQUEST_EVENT,
            &DesktopShellOpenViewRequest {
                view: "runtime".to_string(),
            },
        )
    }

    pub fn open_settings_view(&self, app: &AppHandle) -> Result<(), String> {
        show_main_window(app)?;
        emit_main_window(
            app,
            DESKTOP_SHELL_OPEN_VIEW_REQUEST_EVENT,
            &DesktopShellOpenViewRequest {
                view: "settings".to_string(),
            },
        )
    }

    pub fn handle_menu_event(&self, app: &AppHandle, menu_id: &str) -> Result<(), String> {
        match menu_id {
            MENU_SHOW_MAIN => show_main_window(app),
            MENU_VIEW_RECENT_RISK => self.open_recent_risk_details(app),
            MENU_OPEN_RUNTIME => self.open_runtime_view(app),
            MENU_TOGGLE_SYSTEM_NOTIFICATIONS => {
                let mut preferences = self.get_preferences()?;
                preferences.enable_system_notifications = !preferences.enable_system_notifications;
                self.set_preferences(app, preferences).map(|_| ())
            }
            MENU_TOGGLE_FOREGROUND_RISK_CARD => {
                let mut preferences = self.get_preferences()?;
                preferences.enable_foreground_risk_card = !preferences.enable_foreground_risk_card;
                self.set_preferences(app, preferences).map(|_| ())
            }
            MENU_TOGGLE_HIDE_TO_MENU_BAR => {
                let mut preferences = self.get_preferences()?;
                preferences.hide_to_menu_bar_on_close = !preferences.hide_to_menu_bar_on_close;
                self.set_preferences(app, preferences).map(|_| ())
            }
            MENU_OPEN_SETTINGS => self.open_settings_view(app),
            MENU_QUIT => {
                self.quit_requested.store(true, Ordering::SeqCst);
                app.exit(0);
                Ok(())
            }
            _ => Ok(()),
        }
    }

    pub fn handle_window_event(&self, window: &Window, event: &WindowEvent) -> Result<(), String> {
        if let WindowEvent::CloseRequested { api, .. } = event {
            let preferences = self.get_preferences()?;
            if should_hide_main_window_on_close(
                window.label(),
                &preferences,
                self.quit_requested.load(Ordering::SeqCst),
            ) {
                api.prevent_close();
                window.hide().map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }

    pub fn refresh_tray(&self, app: &AppHandle) -> Result<(), String> {
        let preferences = self.get_preferences()?;
        let inbox = self.get_risk_inbox()?;
        let tray_lock = self
            .tray
            .lock()
            .map_err(|_| "desktop shell tray state is poisoned".to_string())?;
        let Some(handles) = tray_lock.as_ref() else {
            return Ok(());
        };

        handles
            .view_recent_risk
            .set_text(format!("查看最近风险（{}）", inbox.pending_count))
            .map_err(|error| error.to_string())?;
        handles
            .view_recent_risk
            .set_enabled(inbox.pending_count > 0)
            .map_err(|error| error.to_string())?;
        handles
            .system_notifications
            .set_checked(preferences.enable_system_notifications)
            .map_err(|error| error.to_string())?;
        handles
            .foreground_risk_card
            .set_checked(preferences.enable_foreground_risk_card)
            .map_err(|error| error.to_string())?;
        handles
            .hide_to_menu_bar
            .set_checked(preferences.hide_to_menu_bar_on_close)
            .map_err(|error| error.to_string())?;
        handles
            .tray
            .set_icon(Some(load_menu_bar_icon(inbox.pending_count > 0)?))
            .map_err(|error| error.to_string())?;
        handles
            .tray
            .set_icon_as_template(true)
            .map_err(|error| error.to_string())?;
        handles
            .tray
            .set_tooltip(Some(if inbox.pending_count > 0 {
                format!("Aegis：{} 条未处理风险", inbox.pending_count)
            } else {
                "Aegis 正在后台运行".to_string()
            }))
            .map_err(|error| error.to_string())?;
        let _ = app.tray_by_id(TRAY_ID);
        Ok(())
    }
}

pub fn show_main_window(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is unavailable".to_string())?;
    let is_minimized = window.is_minimized().map_err(|error| error.to_string())?;
    if is_minimized {
        window.unminimize().map_err(|error| error.to_string())?;
    }
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

pub fn should_hide_main_window_on_close(
    window_label: &str,
    preferences: &DesktopShellPreferences,
    quit_requested: bool,
) -> bool {
    window_label == "main" && preferences.hide_to_menu_bar_on_close && !quit_requested
}

fn emit_main_window<T: Serialize>(app: &AppHandle, event: &str, payload: &T) -> Result<(), String> {
    app.emit_to("main", event, payload)
        .map_err(|error| error.to_string())
}

fn resolve_preferences_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("failed to resolve app local data dir: {error}"))?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("failed to create app local data dir: {error}"))?;
    Ok(directory.join(DESKTOP_SHELL_PREFERENCES_FILE))
}

fn load_preferences(path: &Path) -> Result<DesktopShellPreferences, String> {
    if !path.exists() {
        let defaults = DesktopShellPreferences::default();
        save_preferences(path, &defaults)?;
        return Ok(defaults);
    }

    let raw = fs::read_to_string(path)
        .map_err(|error| format!("failed to read desktop shell preferences: {error}"))?;
    serde_json::from_str::<DesktopShellPreferences>(&raw)
        .map_err(|error| format!("failed to parse desktop shell preferences: {error}"))
}

fn save_preferences(path: &Path, preferences: &DesktopShellPreferences) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create desktop shell preference dir: {error}"))?;
    }
    let raw = serde_json::to_string_pretty(preferences)
        .map_err(|error| format!("failed to serialize desktop shell preferences: {error}"))?;
    fs::write(path, raw)
        .map_err(|error| format!("failed to write desktop shell preferences: {error}"))
}

fn load_menu_bar_icon(alerting: bool) -> Result<Image<'static>, String> {
    let icon_bytes = if alerting {
        include_bytes!("../icons/menubar-alert-template.png").as_slice()
    } else {
        include_bytes!("../icons/menubar-template.png").as_slice()
    };

    Image::from_bytes(icon_bytes).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        load_menu_bar_icon, save_preferences, should_hide_main_window_on_close,
        DesktopShellPreferences, RuntimeRiskFocusRequest, RuntimeRiskInboxState,
    };
    use crate::runtime_activity::RuntimeSecurityAlertRecord;
    use std::env;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn sample_alert(id: i64, blocked: bool) -> RuntimeSecurityAlertRecord {
        RuntimeSecurityAlertRecord {
            id,
            session_id: format!("session-{id}"),
            source: "codex".to_string(),
            workspace_path: "/tmp/workspace".to_string(),
            event_time: "2026-04-03T10:00:00Z".to_string(),
            severity: "critical".to_string(),
            title: format!("Alert {id}"),
            alert_type: "tool_call".to_string(),
            resource: "bash".to_string(),
            action: "rm -rf".to_string(),
            blocked,
            reason: "sample".to_string(),
            details_json: "{}".to_string(),
        }
    }

    fn unique_temp_path(name: &str) -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be monotonic")
            .as_nanos();
        env::temp_dir().join(format!("agentguard-desktop-{name}-{timestamp}.json"))
    }

    #[test]
    fn desktop_shell_preferences_round_trip() {
        let path = unique_temp_path("desktop-shell-preferences");
        let preferences = DesktopShellPreferences::default();

        save_preferences(&path, &preferences).expect("should save preferences");
        let raw = fs::read_to_string(&path).expect("should read saved preferences");
        let restored: DesktopShellPreferences =
            serde_json::from_str(&raw).expect("should parse saved preferences");

        assert_eq!(restored, preferences);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn runtime_risk_inbox_tracks_pending_and_mark_seen() {
        let alert_one = sample_alert(1, true);
        let alert_two = sample_alert(2, true);
        let alert_three = sample_alert(3, false);
        let mut inbox = RuntimeRiskInboxState::default();

        inbox.ingest_fresh_alerts(&[alert_one.clone(), alert_two.clone()]);
        assert_eq!(inbox.pending_count, 2);
        assert_eq!(inbox.latest_pending_alert_id, Some(2));
        assert_eq!(inbox.latest_alert.as_ref().map(|alert| alert.id), Some(2));

        inbox.mark_seen();
        assert_eq!(inbox.pending_count, 0);
        assert_eq!(inbox.last_seen_alert_id, Some(2));
        assert_eq!(inbox.latest_pending_alert_id, None);

        inbox.ingest_fresh_alerts(&[alert_two.clone(), alert_three.clone()]);
        assert_eq!(inbox.pending_count, 1);
        assert_eq!(inbox.latest_pending_alert_id, Some(3));
        assert_eq!(inbox.latest_alert.as_ref().map(|alert| alert.id), Some(3));

        let focus_request = inbox
            .latest_focus_request()
            .expect("focus request should be available");
        assert_eq!(
            focus_request,
            RuntimeRiskFocusRequest::from_alert(&alert_three)
        );
    }

    #[test]
    fn close_intercept_only_applies_to_main_window() {
        let preferences = DesktopShellPreferences::default();

        assert!(should_hide_main_window_on_close(
            "main",
            &preferences,
            false
        ));
        assert!(!should_hide_main_window_on_close(
            "activity-monitor",
            &preferences,
            false
        ));
        assert!(!should_hide_main_window_on_close(
            "main",
            &preferences,
            true
        ));

        let disabled_preferences = DesktopShellPreferences {
            hide_to_menu_bar_on_close: false,
            ..DesktopShellPreferences::default()
        };
        assert!(!should_hide_main_window_on_close(
            "main",
            &disabled_preferences,
            false
        ));
    }

    #[test]
    fn menu_bar_icons_load_from_embedded_bytes() {
        let default_icon = load_menu_bar_icon(false).expect("default menu bar icon should load");
        let alert_icon = load_menu_bar_icon(true).expect("alert menu bar icon should load");

        assert!(default_icon.width() > 0);
        assert!(default_icon.height() > 0);
        assert!(alert_icon.width() > 0);
        assert!(alert_icon.height() > 0);
    }
}
