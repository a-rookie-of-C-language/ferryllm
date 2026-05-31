import { useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { motion, AnimatePresence } from "framer-motion";
import {
  Activity,
  CheckCircle2,
  CirclePlus,
  Code2,
  FileCog,
  FolderOpen,
  Gauge,
  GripVertical,
  History,
  Moon,
  Network,
  Play,
  Plus,
  RefreshCw,
  Route,
  RotateCw,
  Save,
  Settings,
  Square,
  Sun,
  Terminal,
  Trash2,
  Zap,
} from "lucide-react";
import { cn } from "./lib/utils";
import "./App.css";

/* ── Types ─────────────────────────────────────────────────────────── */

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

type ProviderConfig = {
  name: string;
  type: string;
  base_url: string;
  api_key?: string;
  api_key_env?: string;
  api_key_url?: string;
  api_key_file?: string;
  key_watch?: KeyWatchConfig[];
};
type KeyWatchConfig = { file: string; path: string; url_path?: string };

type RouteConfig = {
  match: string;
  match_type?: "prefix" | "exact";
  provider: string;
  fallback_providers?: string[];
  rewrite_model?: string;
};

type AppConfig = {
  server?: JsonObject;
  logging?: JsonObject;
  auth?: JsonObject;
  metrics?: JsonObject;
  prompt_cache?: JsonObject;
  providers?: ProviderConfig[];
  routes?: RouteConfig[];
};

type CommandResult = { ok: boolean; code: number | null; stdout: string; stderr: string };
type SaveResult = { path: string; validation: CommandResult; reloaded: boolean };
type LogEntry = { ts_ms: number; stream: string; line: string };
type ProcessStatus = { running: boolean; executable: string; config_path: string; pid: number | null; logs: LogEntry[] };

type View = "providers" | "provider-detail" | "launcher";
type DetailTab = "settings" | "routes" | "runtime";
type AITool = "codex" | "claude";

type RecentLaunch = {
  id: string;
  directory: string;
  tool: AITool;
  launchType: "cli" | "vscode";
  providerName: string;
  providerType: string;
  configPath: string;
  lastUsed: number;
};

/* ── Toast ─────────────────────────────────────────────────────────── */

type Toast = { id: number; message: string; type: "info" | "success" | "error" };

function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            className={cn(
              "flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium shadow-lg backdrop-blur-sm",
              "border border-border bg-surface/95 text-fg",
              t.type === "success" && "border-success/40 bg-success-soft",
              t.type === "error" && "border-danger/40 bg-danger-soft"
            )}
            onClick={() => onDismiss(t.id)}
          >
            {t.type === "success" && <CheckCircle2 size={16} className="text-success shrink-0" />}
            {t.type === "error" && <Zap size={16} className="text-danger shrink-0" />}
            <span>{t.message}</span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

/* ── Helpers ────────────────────────────────────────────────────────── */

const emptyConfig: AppConfig = {
  server: { listen: "127.0.0.1:3000", request_timeout_secs: 120, body_limit_mb: 32 },
  logging: { level: "info", format: "text" },
  auth: { enabled: false },
  metrics: { enabled: true },
  prompt_cache: {
    auto_inject_anthropic_cache_control: true,
    cache_system: true,
    cache_tools: true,
    cache_last_user_message: true,
    openai_prompt_cache_key: "ferryllm",
    debug_log_request_shape: true,
  },
  providers: [],
  routes: [],
};

function cloneConfig(c: AppConfig): AppConfig { return JSON.parse(JSON.stringify(c)); }
function valueAsString(v: JsonValue | undefined): string { return v == null ? "" : String(v); }
function valueAsNumber(v: JsonValue | undefined): string { return typeof v === "number" ? String(v) : typeof v === "string" ? v : ""; }
function valueAsBool(v: JsonValue | undefined, fb = false): boolean { return typeof v === "boolean" ? v : fb; }
function splitCsv(v: string): string[] { return v.split(",").map((s) => s.trim()).filter(Boolean); }

function normalizeConfig(c: AppConfig): AppConfig {
  return {
    ...emptyConfig,
    ...c,
    server: { ...emptyConfig.server, ...(c.server ?? {}) },
    logging: { ...emptyConfig.logging, ...(c.logging ?? {}) },
    auth: { ...emptyConfig.auth, ...(c.auth ?? {}) },
    metrics: { ...emptyConfig.metrics, ...(c.metrics ?? {}) },
    prompt_cache: { ...emptyConfig.prompt_cache, ...(c.prompt_cache ?? {}) },
    providers: c.providers ?? [],
    routes: c.routes ?? [],
  };
}

/* ── Animated card wrapper ─────────────────────────────────────────── */

function Card({ children, active, onClick, className }: {
  children: ReactNode;
  active?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <motion.button
      type="button"
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      onClick={onClick}
      className={cn(
        "group flex w-full items-center gap-4 rounded-2xl border p-5 text-left transition-all duration-200",
        "bg-surface hover:shadow-md",
        active
          ? "border-primary/50 shadow-[0_0_0_1px_rgba(37,99,235,0.15)] ring-1 ring-primary/20"
          : "border-border hover:border-border-strong",
        className
      )}
    >
      {children}
    </motion.button>
  );
}

/* ── Main App ──────────────────────────────────────────────────────── */

function App() {
  const [executable, setExecutable] = useState("ferryllm");
  const [config, setConfig] = useState<AppConfig>(emptyConfig);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState(0);
  const [selectedRoute, setSelectedRoute] = useState(0);
  const hotReload = true;
  const [status, setStatus] = useState<ProcessStatus | null>(null);
  const [validation, setValidation] = useState<CommandResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeView, setActiveView] = useState<View>("providers");
  const [detailTab, setDetailTab] = useState<DetailTab>("settings");
  const [darkMode, setDarkMode] = useState(() => {
    const s = localStorage.getItem("ferryllm-theme");
    if (s) return s === "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [recentLaunches, setRecentLaunches] = useState<RecentLaunch[]>(() => {
    try { return JSON.parse(localStorage.getItem("ferryllm-launches") || "[]"); } catch { return []; }
  });
  const [launchTool, setLaunchTool] = useState<AITool>("codex");
  let toastId = 0;

  const providers = config.providers ?? [];
  const routes = config.routes ?? [];
  const selectedProviderConfig = providers[selectedProvider];
  const selectedRouteConfig = routes[selectedRoute];
  const providerNames = useMemo(() => providers.map((p) => p.name).filter(Boolean), [providers]);

  function addToast(message: string, type: Toast["type"] = "info") {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3500);
  }

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", darkMode ? "dark" : "light");
    localStorage.setItem("ferryllm-theme", darkMode ? "dark" : "light");
  }, [darkMode]);

  useEffect(() => {
    void bootstrap();
    const unlisten = listen<LogEntry>("server-log", () => void refreshStatus());
    return () => { void unlisten.then((u) => u()); };
  }, []);

  /* ── Load config from file on startup ── */
  useEffect(() => {
    (async () => {
      try {
        const stored = await invoke<string | null>("load_config_from_default");
        if (stored) {
          setConfig(normalizeConfig(JSON.parse(stored)));
        }
      } catch { /* ignore, use empty config */ }
      setConfigLoaded(true);
    })();
  }, []);

  /* ── Auto-save config to file + localStorage ── */
  useEffect(() => {
    if (!configLoaded) return;
    localStorage.setItem("ferryllm-config", JSON.stringify(config));
    invoke("save_config_to_default", { request: { config } }).catch(() => {});
  }, [config, configLoaded]);

  /* ── Backend calls ─────────────────────────────────────── */

  async function bootstrap() {
    try {
      const [discovered, st] = await Promise.all([
        invoke<string>("discover_ferryllm"),
        invoke<ProcessStatus>("server_status"),
      ]);
      setExecutable(discovered);
      setStatus(st);
    } catch (e) { addToast(String(e), "error"); }
  }

  async function syncConfigToFile(): Promise<string> {
    return await invoke<string>("write_config_to_default", { request: { config } });
  }

  async function saveConfig() {
    setBusy(true);
    try {
      const path = await syncConfigToFile();
      const r = await invoke<SaveResult>("save_config_file", {
        request: { path, config, executable, hot_reload: hotReload },
      });
      setValidation(r.validation);
      await refreshStatus();
      addToast(r.reloaded ? "Saved & hot reloaded" : "Saved & validated", "success");
    } catch (e) { addToast(String(e), "error"); }
    finally { setBusy(false); }
  }

  async function validateConfig() {
    setBusy(true);
    try {
      const path = await syncConfigToFile();
      const r = await invoke<CommandResult>("validate_config_file", { executable, configPath: path });
      setValidation(r);
      addToast(r.ok ? "Config is valid" : "Validation failed", r.ok ? "success" : "error");
    } catch (e) { addToast(String(e), "error"); }
    finally { setBusy(false); }
  }

  async function startServer() {
    setBusy(true);
    try {
      const path = await syncConfigToFile();
      const s = await invoke<ProcessStatus>("start_server", { request: { executable, config_path: path } });
      setStatus(s);
      addToast("ferryllm started", "success");
    } catch (e) { addToast(String(e), "error"); }
    finally { setBusy(false); }
  }

  async function stopServer() {
    setBusy(true);
    try {
      const s = await invoke<ProcessStatus>("stop_server");
      setStatus(s);
      addToast("ferryllm stopped", "success");
    } catch (e) { addToast(String(e), "error"); }
    finally { setBusy(false); }
  }

  async function restartServer() {
    setBusy(true);
    try {
      const path = await syncConfigToFile();
      const s = await invoke<ProcessStatus>("restart_server", { request: { executable, config_path: path } });
      setStatus(s);
      addToast("ferryllm restarted", "success");
    } catch (e) { addToast(String(e), "error"); }
    finally { setBusy(false); }
  }

  async function refreshStatus() {
    setStatus(await invoke<ProcessStatus>("server_status"));
  }

  function recordLaunch(directory: string, tool: AITool, launchType: "cli" | "vscode") {
    if (!selectedProviderConfig) return;
    const entry: RecentLaunch = {
      id: Date.now().toString(36),
      directory,
      tool,
      launchType,
      providerName: selectedProviderConfig.name,
      providerType: selectedProviderConfig.type,
      configPath: "localStorage",
      lastUsed: Date.now(),
    };
    setRecentLaunches((prev) => {
      const deduped = prev.filter((r) => !(r.directory === directory && r.tool === tool && r.launchType === launchType));
      const next = [entry, ...deduped].slice(0, 50);
      localStorage.setItem("ferryllm-launches", JSON.stringify(next));
      return next;
    });
  }

  function deleteLaunch(id: string) {
    setRecentLaunches((prev) => {
      const next = prev.filter((r) => r.id !== id);
      localStorage.setItem("ferryllm-launches", JSON.stringify(next));
      return next;
    });
  }

  async function launchCli() {
    const dir = await open({ directory: true, title: "Select working directory for CLI" });
    if (!dir || !selectedProviderConfig) return;
    const listen = valueAsString(config.server?.listen) || "127.0.0.1:3000";
    try {
      await invoke("launch_cli", { request: { directory: dir, listen, provider_type: selectedProviderConfig.type, tool: launchTool } });
      recordLaunch(dir, launchTool, "cli");
      addToast(`${launchTool} CLI launched`, "success");
    } catch (e) { addToast(String(e), "error"); }
  }

  async function launchVscode() {
    const dir = await open({ directory: true, title: "Select working directory for VS Code" });
    if (!dir || !selectedProviderConfig) return;
    const listen = valueAsString(config.server?.listen) || "127.0.0.1:3000";
    try {
      await invoke("launch_vscode", { request: { directory: dir, listen, provider_type: selectedProviderConfig.type, tool: launchTool } });
      recordLaunch(dir, launchTool, "vscode");
      addToast("VS Code launched", "success");
    } catch (e) { addToast(String(e), "error"); }
  }

  async function quickLaunch(item: RecentLaunch) {
    const listen = valueAsString(config.server?.listen) || "127.0.0.1:3000";
    try {
      if (item.launchType === "vscode") {
        await invoke("launch_vscode", { request: { directory: item.directory, listen, provider_type: item.providerType, tool: item.tool } });
      } else {
        await invoke("launch_cli", { request: { directory: item.directory, listen, provider_type: item.providerType, tool: item.tool } });
      }
      setRecentLaunches((prev) => {
        const next = prev.map((r) => r.id === item.id ? { ...r, lastUsed: Date.now() } : r).sort((a, b) => b.lastUsed - a.lastUsed);
        localStorage.setItem("ferryllm-launches", JSON.stringify(next));
        return next;
      });
      addToast(`${item.launchType === "vscode" ? "VS Code" : item.tool + " CLI"} launched`, "success");
    } catch (e) { addToast(String(e), "error"); }
  }

  /* ── Config mutation helpers ──────────────────────────── */

  function updateSection(section: keyof AppConfig, key: string, value: JsonValue | undefined) {
    setConfig((cur) => {
      const next = cloneConfig(cur);
      const target = ((next[section] as JsonObject | undefined) ?? {}) as JsonObject;
      if (value === undefined || value === "") delete target[key];
      else target[key] = value;
      next[section] = target as never;
      return next;
    });
  }

  function updateProvider(index: number, patch: Partial<ProviderConfig>) {
    setConfig((cur) => {
      const next = cloneConfig(cur);
      const list = [...(next.providers ?? [])];
      list[index] = { ...list[index], ...patch };
      next.providers = list;
      return next;
    });
  }

  function addProvider() {
    setConfig((cur) => {
      const next = cloneConfig(cur);
      next.providers = [...(next.providers ?? []), { name: `provider-${(next.providers ?? []).length + 1}`, type: "openai", base_url: "" }];
      setSelectedProvider(next.providers.length - 1);
      setDetailTab("settings");
      setActiveView("provider-detail");
      return next;
    });
  }

  function removeProvider(index: number) {
    setConfig((cur) => {
      const next = cloneConfig(cur);
      next.providers = (next.providers ?? []).filter((_, i) => i !== index);
      setSelectedProvider(0);
      return next;
    });
  }

  function updateKeyWatch(pi: number, wi: number, patch: Partial<KeyWatchConfig>) {
    const watches = [...(providers[pi].key_watch ?? [])];
    watches[wi] = { ...watches[wi], ...patch };
    updateProvider(pi, { key_watch: watches });
  }

  function addKeyWatch(pi: number) {
    updateProvider(pi, {
      key_watch: [...(providers[pi].key_watch ?? []), { file: "", path: "", url_path: "" }],
      api_key: undefined, api_key_env: undefined, api_key_url: undefined, api_key_file: undefined,
    });
  }

  function updateRoute(index: number, patch: Partial<RouteConfig>) {
    setConfig((cur) => {
      const next = cloneConfig(cur);
      const list = [...(next.routes ?? [])];
      list[index] = { ...list[index], ...patch };
      next.routes = list;
      return next;
    });
  }

  function addRoute() {
    setConfig((cur) => {
      const next = cloneConfig(cur);
      next.routes = [...(next.routes ?? []), { match: "*", match_type: "prefix", provider: providerNames[0] ?? "", fallback_providers: [] }];
      setSelectedRoute(next.routes.length - 1);
      setDetailTab("routes");
      return next;
    });
  }

  function removeRoute(index: number) {
    setConfig((cur) => {
      const next = cloneConfig(cur);
      next.routes = (next.routes ?? []).filter((_, i) => i !== index);
      setSelectedRoute(0);
      return next;
    });
  }

  /* ── Render ───────────────────────────────────────────── */

  return (
    <div className="flex min-h-screen flex-col bg-bg text-fg">
      {/* ── Header ────────────────────────────── */}
      <header className="sticky top-0 z-30 border-b border-border bg-surface/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between px-6">
          {/* Brand / Back */}
          {activeView === "provider-detail" ? (
            <button
              type="button"
              onClick={() => setActiveView("providers")}
              className="flex items-center gap-3 text-muted hover:text-heading transition-colors"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className="shrink-0">
                <path d="M12 4l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <span className="text-sm font-semibold">Back</span>
            </button>
          ) : (
            <div className="flex items-center gap-3">
              <img src="/logo-light.png" alt="ferryllm" className="h-7 dark:hidden" />
              <img src="/logo-dark.png" alt="ferryllm" className="h-7 hidden dark:block" />
            </div>
          )}

          {/* View switcher — show on main views */}
          {(activeView === "providers" || activeView === "launcher") && (
            <nav className="flex items-center gap-1 rounded-xl bg-muted-soft p-1">
              {([
                { view: "providers" as View, icon: <FileCog size={16} />, label: "Providers" },
                { view: "launcher" as View, icon: <History size={16} />, label: "Launcher" },
              ]).map(({ view, icon, label }) => (
                <button
                  key={view}
                  type="button"
                  onClick={() => setActiveView(view)}
                  className={cn(
                    "relative flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors",
                    activeView === view ? "text-heading" : "text-muted hover:text-icon-hover"
                  )}
                >
                  {activeView === view && (
                    <motion.div
                      layoutId="activeTab"
                      className="absolute inset-0 rounded-lg bg-surface shadow-sm"
                      transition={{ type: "spring", stiffness: 400, damping: 30 }}
                    />
                  )}
                  <span className="relative z-10 flex items-center gap-2">{icon} {label}</span>
                </button>
              ))}
            </nav>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2">
            {activeView === "provider-detail" && (
              <div className="flex items-center gap-1 rounded-xl border border-border bg-surface p-1">
                {[
                  { icon: <CheckCircle2 size={16} />, action: validateConfig, tip: "Validate", disabled: busy },
                  { icon: <RefreshCw size={16} />, action: refreshStatus, tip: "Refresh", disabled: busy },
                ].map((b, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={b.action}
                    disabled={b.disabled}
                    title={b.tip}
                    className="inline-grid h-9 w-9 place-items-center rounded-lg text-icon transition-colors hover:bg-muted-soft hover:text-icon-hover disabled:opacity-40"
                  >
                    {b.icon}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={() => setDarkMode((d) => !d)}
              title={darkMode ? "Light mode" : "Dark mode"}
              className="inline-grid h-9 w-9 place-items-center rounded-lg text-icon transition-colors hover:bg-muted-soft hover:text-icon-hover"
            >
              {darkMode ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            {activeView === "providers" && (
              <button
                type="button"
                onClick={addProvider}
                title="Add provider"
                className="inline-flex h-9 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-semibold text-white shadow-sm transition-all hover:bg-accent-hover hover:shadow-md"
              >
                <Plus size={16} /> Add
              </button>
            )}
          </div>
        </div>
      </header>

      {/* ── Main ───────────────────────────────── */}
      <main className="mx-auto w-full max-w-[1440px] flex-1 px-6 py-6">
        <AnimatePresence mode="wait">
          {/* ── Providers List ── */}
          {activeView === "providers" && (
            <motion.div
              key="providers"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.2 }}
              className="mx-auto max-w-[720px]"
            >
              <section className="flex flex-col gap-3" aria-label="Providers">
                {providers.length ? providers.map((p, i) => (
                  <Card key={`${p.name}-${i}`} active={selectedProvider === i} onClick={() => { setSelectedProvider(i); setDetailTab("settings"); setActiveView("provider-detail"); }}>
                    <GripVertical size={18} className="text-icon shrink-0 opacity-40 group-hover:opacity-70 transition-opacity" />
                    <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-bg text-lg font-bold text-primary shrink-0">
                      {p.name?.slice(0, 1).toUpperCase() || "P"}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-3">
                        <strong className="truncate text-lg font-bold text-heading">{p.name || "Unnamed"}</strong>
                        <span className="rounded-full bg-info-soft px-2.5 py-0.5 text-xs font-semibold text-primary">{p.type}</span>
                      </div>
                      <p className="mt-1 truncate text-sm text-muted">{p.base_url || "No base URL"}</p>
                    </div>
                    {p.key_watch?.length ? (
                      <span className="rounded-full bg-success-soft px-3 py-1 text-xs font-bold text-success">key watch</span>
                    ) : null}
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); removeProvider(i); }}
                      title="Delete provider"
                      className="ml-2 inline-grid h-8 w-8 place-items-center rounded-lg text-icon opacity-0 transition-all group-hover:opacity-100 hover:bg-danger-soft hover:text-danger"
                    >
                      <Trash2 size={14} />
                    </button>
                  </Card>
                )) : (
                  <EmptyState title="No providers" action="Add provider" onAction={addProvider} />
                )}
              </section>
            </motion.div>
          )}

          {/* ── Provider Detail Page ── */}
          {activeView === "provider-detail" && selectedProviderConfig && (
            <motion.div
              key="provider-detail"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.2 }}
              className="mx-auto max-w-[960px] space-y-5"
            >
              {/* Provider name header */}
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg text-lg font-bold text-primary">
                  {selectedProviderConfig.name?.slice(0, 1).toUpperCase() || "P"}
                </div>
                <div>
                  <h2 className="text-lg font-bold text-heading">{selectedProviderConfig.name || "Unnamed Provider"}</h2>
                  <span className="text-xs text-muted">{selectedProviderConfig.type}</span>
                </div>
              </div>

              {/* Service bar */}
              <div className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
                <div className="flex flex-wrap items-center gap-3">
                  <div className={cn(
                    "flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium",
                    status?.running ? "bg-success-soft text-success" : "bg-muted-soft text-muted"
                  )}>
                    <Terminal size={14} />
                    <span>{status?.running ? "Running" : "Stopped"}</span>
                    {status?.pid && <strong className="font-bold">PID {status.pid}</strong>}
                  </div>
                  <Button variant="success" icon={<Play size={14} />} onClick={startServer} disabled={busy || status?.running}>Start</Button>
                  <Button variant="danger" icon={<Square size={14} />} onClick={stopServer} disabled={busy || !status?.running}>Stop</Button>
                  <Button variant="danger" icon={<Square size={14} />} onClick={stopServer} disabled={busy || !status?.running}>Stop</Button>
                  <Button icon={<RotateCw size={14} />} onClick={restartServer} disabled={busy}>Restart</Button>
                  <Button variant="primary" icon={<Save size={14} />} onClick={saveConfig} disabled={busy}>Save</Button>
                  <Button icon={<CheckCircle2 size={14} />} onClick={validateConfig} disabled={busy}>Validate</Button>
                  <div className="ml-auto flex items-center gap-3 border-l border-border pl-4">
                    {/* Tool segmented control */}
                    <div className="flex items-center gap-0.5 rounded-lg bg-muted-soft p-0.5">
                      {([
                        { tool: "codex" as AITool, icon: <Code2 size={13} />, label: "Codex" },
                        { tool: "claude" as AITool, icon: <Zap size={13} />, label: "Claude" },
                      ]).map(({ tool, icon, label }) => (
                        <button
                          key={tool}
                          type="button"
                          onClick={() => setLaunchTool(tool)}
                          className={cn(
                            "relative flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors duration-200",
                            launchTool === tool ? "text-heading" : "text-muted hover:text-icon-hover"
                          )}
                        >
                          {launchTool === tool && (
                            <motion.div
                              layoutId="launchTool"
                              className="absolute inset-0 rounded-md bg-surface shadow-sm"
                              transition={{ type: "spring", stiffness: 500, damping: 35 }}
                            />
                          )}
                          <span className="relative z-10 flex items-center gap-1.5">
                            {icon} {label}
                          </span>
                        </button>
                      ))}
                    </div>
                    <Button icon={<Terminal size={14} />} onClick={launchCli} disabled={!status?.running} title={`Launch ${launchTool} CLI`}>Launch CLI</Button>
                    <Button icon={<Code2 size={14} />} onClick={launchVscode} disabled={!status?.running} title="Launch VS Code">VS Code</Button>
                  </div>
                </div>
              </div>

              {/* Sub-tabs: Settings | Routes | Runtime */}
              <nav className="flex items-center gap-1 rounded-xl bg-muted-soft p-1">
                {([
                  { tab: "settings" as DetailTab, icon: <Settings size={14} />, label: "Settings" },
                  { tab: "routes" as DetailTab, icon: <Route size={14} />, label: "Routes" },
                  { tab: "runtime" as DetailTab, icon: <Gauge size={14} />, label: "Runtime" },
                ]).map(({ tab, icon, label }) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setDetailTab(tab)}
                    className={cn(
                      "relative flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-all duration-200",
                      detailTab === tab ? "text-heading" : "text-muted hover:text-icon-hover"
                    )}
                  >
                    {detailTab === tab && (
                      <motion.div
                        layoutId="detailTab"
                        className="absolute inset-0 rounded-lg bg-surface shadow-sm"
                        transition={{ type: "spring", stiffness: 400, damping: 30 }}
                      />
                    )}
                    <span className="relative z-10 flex items-center gap-2">{icon} {label}</span>
                  </button>
                ))}
              </nav>

              {/* Sub-tab content */}
              <AnimatePresence mode="wait">
                {detailTab === "settings" && (
                  <motion.div key="dt-settings" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.15 }}>
                    <div className="rounded-2xl border border-border bg-surface shadow-sm overflow-hidden">
                      <PanelHeader title="Provider Settings" subtitle="Use env, URL, file, or watched config paths for API keys." />
                      <div className="grid gap-5 p-6">
                        <div className="grid grid-cols-2 gap-4">
                          <TextField label="Provider Name" value={selectedProviderConfig.name} onChange={(v) => updateProvider(selectedProvider, { name: v })} />
                          <SelectField label="Type" value={selectedProviderConfig.type} options={["openai", "openai_responses", "anthropic", "gemini"]} onChange={(v) => updateProvider(selectedProvider, { type: v })} />
                        </div>
                        <TextField label="Base URL" value={selectedProviderConfig.base_url} onChange={(v) => updateProvider(selectedProvider, { base_url: v })} />
                        <TextField label="API Key (direct)" value={selectedProviderConfig.api_key ?? ""} onChange={(v) => updateProvider(selectedProvider, { api_key: v || undefined, api_key_env: undefined, api_key_url: undefined, api_key_file: undefined, key_watch: undefined })} />
                        <div className="grid grid-cols-2 gap-4">
                          <TextField label="API key env" value={selectedProviderConfig.api_key_env ?? ""} onChange={(v) => updateProvider(selectedProvider, { api_key_env: v || undefined, api_key: undefined, api_key_url: undefined, api_key_file: undefined, key_watch: undefined })} />
                          <TextField label="API key URL" value={selectedProviderConfig.api_key_url ?? ""} onChange={(v) => updateProvider(selectedProvider, { api_key_url: v || undefined, api_key: undefined, api_key_env: undefined, api_key_file: undefined, key_watch: undefined })} />
                        </div>
                        <TextField label="API key file" value={selectedProviderConfig.api_key_file ?? ""} onChange={(v) => updateProvider(selectedProvider, { api_key_file: v || undefined, api_key: undefined, api_key_env: undefined, api_key_url: undefined, key_watch: undefined })} />
                        <div className="flex justify-end gap-2">
                          <Button icon={<Activity size={14} />} onClick={() => addKeyWatch(selectedProvider)}>Add key watch</Button>
                          <Button variant="danger" icon={<Trash2 size={14} />} onClick={() => { removeProvider(selectedProvider); setActiveView("providers"); }}>Remove provider</Button>
                        </div>
                        {(selectedProviderConfig.key_watch ?? []).map((w, wi) => (
                          <div key={wi} className="grid gap-3 rounded-xl border border-border bg-muted-soft p-4">
                            <TextField label="Watch file" value={w.file} onChange={(v) => updateKeyWatch(selectedProvider, wi, { file: v })} />
                            <TextField label="Key path" value={w.path} onChange={(v) => updateKeyWatch(selectedProvider, wi, { path: v })} />
                            <TextField label="URL path" value={w.url_path ?? ""} onChange={(v) => updateKeyWatch(selectedProvider, wi, { url_path: v || undefined })} />
                          </div>
                        ))}
                      </div>
                    </div>
                  </motion.div>
                )}

                {detailTab === "routes" && (
                  <motion.div key="dt-routes" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.15 }} className="grid grid-cols-[minmax(300px,1fr)_minmax(280px,0.6fr)] gap-5 items-start">
                    {/* Routes list */}
                    <section className="flex flex-col gap-3" aria-label="Routes">
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-bold text-heading">Routes</h3>
                        <Button icon={<Plus size={14} />} onClick={addRoute}>Add route</Button>
                      </div>
                      {routes.length ? routes.map((r, i) => (
                        <Card key={`${r.match}-${i}`} active={selectedRoute === i} onClick={() => setSelectedRoute(i)}>
                          <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-bg shrink-0">
                            <Network size={16} className="text-purple-500" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <strong className="truncate text-sm font-bold text-heading">{r.match || "Empty"}</strong>
                              <span className="rounded-full bg-info-soft px-2 py-0.5 text-[11px] font-semibold text-primary">{r.match_type ?? "prefix"}</span>
                            </div>
                            <p className="mt-0.5 truncate text-xs text-muted">
                              {r.provider || "No provider"}{r.rewrite_model ? ` → ${r.rewrite_model}` : ""}
                            </p>
                          </div>
                          {r.fallback_providers?.length ? (
                            <span className="rounded-full bg-success-soft px-2.5 py-0.5 text-[11px] font-bold text-success">fallback</span>
                          ) : null}
                        </Card>
                      )) : (
                        <EmptyState title="No routes" action="Add route" onAction={addRoute} />
                      )}
                    </section>
                    {/* Route detail */}
                    <section className="rounded-2xl border border-border bg-surface shadow-sm overflow-hidden">
                      {selectedRouteConfig ? (
                        <>
                          <PanelHeader title="Route Details" subtitle="Match model names, choose a provider, optionally rewrite." />
                          <div className="grid gap-4 p-5">
                            <div className="grid grid-cols-2 gap-3">
                              <TextField label="Match" value={selectedRouteConfig.match} onChange={(v) => updateRoute(selectedRoute, { match: v })} />
                              <SelectField label="Match type" value={selectedRouteConfig.match_type ?? "prefix"} options={["prefix", "exact"]} onChange={(v) => updateRoute(selectedRoute, { match_type: v as "prefix" | "exact" })} />
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                              <SelectField label="Provider" value={selectedRouteConfig.provider} options={providerNames} onChange={(v) => updateRoute(selectedRoute, { provider: v })} />
                              <TextField label="Rewrite model" value={selectedRouteConfig.rewrite_model ?? ""} onChange={(v) => updateRoute(selectedRoute, { rewrite_model: v || undefined })} />
                            </div>
                            <TextField label="Fallback providers CSV" value={(selectedRouteConfig.fallback_providers ?? []).join(", ")} onChange={(v) => updateRoute(selectedRoute, { fallback_providers: splitCsv(v) })} />
                            <div className="flex justify-end">
                              <Button variant="danger" icon={<Trash2 size={14} />} onClick={() => removeRoute(selectedRoute)}>Remove</Button>
                            </div>
                          </div>
                        </>
                      ) : <EmptyState title="No route selected" action="Add route" onAction={addRoute} />}
                    </section>
                  </motion.div>
                )}

                {detailTab === "runtime" && (
                  <motion.div key="dt-runtime" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.15 }}>
                    <div className="rounded-2xl border border-border bg-surface shadow-sm overflow-hidden">
                      <PanelHeader title="Runtime Settings" subtitle="Server, access, metrics, prompt cache, and logging." />
                      <div className="grid grid-cols-2 gap-5 p-6">
                        <TextField label="Listen" value={valueAsString(config.server?.listen)} onChange={(v) => updateSection("server", "listen", v)} />
                        <NumberField label="Timeout seconds" value={valueAsNumber(config.server?.request_timeout_secs)} onChange={(v) => updateSection("server", "request_timeout_secs", v)} />
                        <NumberField label="Body limit MB" value={valueAsNumber(config.server?.body_limit_mb)} onChange={(v) => updateSection("server", "body_limit_mb", v)} />
                        <NumberField label="Max concurrency" optional value={valueAsNumber(config.server?.max_concurrent_requests)} onChange={(v) => updateSection("server", "max_concurrent_requests", v)} />
                        <NumberField label="Rate/minute" optional value={valueAsNumber(config.server?.rate_limit_per_minute)} onChange={(v) => updateSection("server", "rate_limit_per_minute", v)} />
                        <SelectField label="Reasoning" value={valueAsString(config.server?.default_reasoning_effort)} options={["", "none", "low", "medium", "high", "xhigh"]} onChange={(v) => updateSection("server", "default_reasoning_effort", v)} />
                        <NumberField label="Retry attempts" value={valueAsNumber(config.server?.retry_attempts)} onChange={(v) => updateSection("server", "retry_attempts", v)} />
                        <NumberField label="Retry backoff ms" value={valueAsNumber(config.server?.retry_backoff_ms)} onChange={(v) => updateSection("server", "retry_backoff_ms", v)} />
                        <NumberField label="Circuit failures" optional value={valueAsNumber(config.server?.circuit_breaker_failures)} onChange={(v) => updateSection("server", "circuit_breaker_failures", v)} />
                        <NumberField label="Circuit cooldown" optional value={valueAsNumber(config.server?.circuit_breaker_cooldown_secs)} onChange={(v) => updateSection("server", "circuit_breaker_cooldown_secs", v)} />
                        <SelectField label="Log level" value={valueAsString(config.logging?.level)} options={["trace", "debug", "info", "warn", "error"]} onChange={(v) => updateSection("logging", "level", v)} />
                        <SelectField label="Log format" value={valueAsString(config.logging?.format)} options={["text", "json"]} onChange={(v) => updateSection("logging", "format", v)} />
                        <BoolField label="Auth enabled" checked={valueAsBool(config.auth?.enabled)} onChange={(v) => updateSection("auth", "enabled", v)} />
                        <TextField label="API keys env" value={valueAsString(config.auth?.api_keys_env)} onChange={(v) => updateSection("auth", "api_keys_env", v)} />
                        <NumberField label="Per-key rate/minute" optional value={valueAsNumber(config.auth?.per_key_rate_limit_per_minute)} onChange={(v) => updateSection("auth", "per_key_rate_limit_per_minute", v)} />
                        <NumberField label="Per-key concurrency" optional value={valueAsNumber(config.auth?.per_key_max_concurrent_requests)} onChange={(v) => updateSection("auth", "per_key_max_concurrent_requests", v)} />
                        <BoolField label="Metrics enabled" checked={valueAsBool(config.metrics?.enabled, true)} onChange={(v) => updateSection("metrics", "enabled", v)} />
                        <BoolField label="Anthropic cache control" checked={valueAsBool(config.prompt_cache?.auto_inject_anthropic_cache_control, true)} onChange={(v) => updateSection("prompt_cache", "auto_inject_anthropic_cache_control", v)} />
                        <BoolField label="Cache system" checked={valueAsBool(config.prompt_cache?.cache_system, true)} onChange={(v) => updateSection("prompt_cache", "cache_system", v)} />
                        <BoolField label="Cache tools" checked={valueAsBool(config.prompt_cache?.cache_tools, true)} onChange={(v) => updateSection("prompt_cache", "cache_tools", v)} />
                        <BoolField label="Cache last user" checked={valueAsBool(config.prompt_cache?.cache_last_user_message, true)} onChange={(v) => updateSection("prompt_cache", "cache_last_user_message", v)} />
                        <TextField label="OpenAI cache key" value={valueAsString(config.prompt_cache?.openai_prompt_cache_key)} onChange={(v) => updateSection("prompt_cache", "openai_prompt_cache_key", v)} />
                        <TextField label="Retention" value={valueAsString(config.prompt_cache?.openai_prompt_cache_retention)} onChange={(v) => updateSection("prompt_cache", "openai_prompt_cache_retention", v)} />
                        <BoolField label="Debug shape" checked={valueAsBool(config.prompt_cache?.debug_log_request_shape, true)} onChange={(v) => updateSection("prompt_cache", "debug_log_request_shape", v)} />
                        <TextField label="Relocate byte range" value={valueAsString(config.prompt_cache?.relocate_system_prefix_range)} onChange={(v) => updateSection("prompt_cache", "relocate_system_prefix_range", v)} />
                        <BoolField label="Log relocated text" checked={valueAsBool(config.prompt_cache?.log_relocated_system_text)} onChange={(v) => updateSection("prompt_cache", "log_relocated_system_text", v)} />
                        <TextField label="Strip prefixes CSV" value={Array.isArray(config.prompt_cache?.strip_system_line_prefixes) ? (config.prompt_cache?.strip_system_line_prefixes as JsonValue[]).join(", ") : ""} onChange={(v) => updateSection("prompt_cache", "strip_system_line_prefixes", splitCsv(v))} />
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Validation */}
              <div className="rounded-2xl border border-border bg-surface overflow-hidden">
                <h2 className="border-b border-border px-5 py-4 text-sm font-bold text-heading">Validation</h2>
                <pre className={cn(
                  "h-40 overflow-auto p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap",
                  validation?.ok ? "text-success" : "text-fg"
                )}>
                  {validation ? `${validation.stdout}${validation.stderr}`.trim() || "config ok" : "Not validated yet."}
                </pre>
              </div>
            </motion.div>
          )}

          {/* ── Launcher View ── */}
          {activeView === "launcher" && (
            <motion.div
              key="launcher"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.2 }}
              className="mx-auto max-w-[800px]"
            >
              <div className="mb-5 flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-heading">Quick Launch</h2>
                  <p className="text-sm text-muted">Launch AI tools with pre-configured providers</p>
                </div>
                <div className="flex items-center gap-0.5 rounded-lg bg-muted-soft p-0.5">
                  {([
                    { tool: "codex" as AITool, icon: <Code2 size={13} />, label: "Codex" },
                    { tool: "claude" as AITool, icon: <Zap size={13} />, label: "Claude" },
                  ]).map(({ tool, icon, label }) => (
                    <button
                      key={tool}
                      type="button"
                      onClick={() => setLaunchTool(tool)}
                      className={cn(
                        "relative flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors duration-200",
                        launchTool === tool ? "text-heading" : "text-muted hover:text-icon-hover"
                      )}
                    >
                      {launchTool === tool && (
                        <motion.div
                          layoutId="launchTool"
                          className="absolute inset-0 rounded-md bg-surface shadow-sm"
                          transition={{ type: "spring", stiffness: 500, damping: 35 }}
                        />
                      )}
                      <span className="relative z-10 flex items-center gap-1.5">
                        {icon} {label}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {recentLaunches.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {recentLaunches.map((item) => (
                    <div
                      key={item.id}
                      className="group flex items-center gap-4 rounded-xl border border-border bg-surface p-4 transition-all hover:border-border-strong hover:shadow-sm"
                    >
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted-soft shrink-0">
                        <FolderOpen size={18} className="text-icon" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <strong className="truncate text-sm font-bold text-heading">
                            {item.directory.split(/[\\/]/).pop() || item.directory}
                          </strong>
                          <span className={cn(
                            "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                            item.tool === "codex" ? "bg-info-soft text-primary" : "bg-success-soft text-success"
                          )}>
                            {item.tool}
                          </span>
                          <span className={cn(
                            "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                            item.launchType === "vscode" ? "bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400" : "bg-orange-100 text-orange-600 dark:bg-orange-900/30 dark:text-orange-400"
                          )}>
                            {item.launchType === "vscode" ? "VS Code" : "CLI"}
                          </span>
                          <span className="rounded-full bg-muted-soft px-2 py-0.5 text-[11px] font-semibold text-muted">
                            {item.providerName}
                          </span>
                        </div>
                        <p className="mt-0.5 truncate text-xs text-muted">{item.directory}</p>
                      </div>
                      <span className="text-[11px] text-muted shrink-0">
                        {new Date(item.lastUsed).toLocaleDateString()}
                      </span>
                      <button
                        type="button"
                        onClick={() => quickLaunch(item)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-white opacity-0 transition-all group-hover:opacity-100 hover:bg-primary-hover"
                      >
                        <Play size={12} /> Launch
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteLaunch(item.id)}
                        className="inline-grid h-8 w-8 place-items-center rounded-lg text-icon opacity-0 transition-all group-hover:opacity-100 hover:bg-danger-soft hover:text-danger"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border-strong bg-muted-soft py-20 text-center">
                  <History size={40} className="mb-3 text-muted" />
                  <strong className="text-base font-bold text-heading">No recent launches</strong>
                  <p className="mt-1 text-sm text-muted">Launch a CLI or VS Code from a provider to see it here</p>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

      </main>

      <ToastContainer toasts={toasts} onDismiss={(id) => setToasts((p) => p.filter((t) => t.id !== id))} />
    </div>
  );
}

/* ── Shared UI atoms ───────────────────────────────────────────────── */

function Button({ children, variant, icon, onClick, disabled, title }: {
  children?: ReactNode;
  variant?: "primary" | "success" | "danger";
  icon?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "inline-flex h-9 items-center gap-2 rounded-xl px-4 text-sm font-semibold transition-all duration-150",
        variant === "primary" && "bg-primary text-white hover:bg-primary-hover shadow-sm",
        variant === "success" && "bg-success-soft text-success hover:brightness-95",
        variant === "danger" && "bg-danger-soft text-danger hover:brightness-95",
        !variant && "bg-muted-soft text-fg hover:bg-border",
        disabled && "opacity-50 cursor-not-allowed"
      )}
    >
      {icon} {children}
    </button>
  );
}

function PanelHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="border-b border-border px-6 py-5">
      <h2 className="text-base font-bold text-heading">{title}</h2>
      <p className="mt-1 text-sm text-muted">{subtitle}</p>
    </div>
  );
}

function EmptyState({ title, action, onAction }: { title: string; action: string; onAction: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border-strong bg-muted-soft py-16 text-center">
      <CirclePlus size={36} className="mb-3 text-muted" />
      <strong className="text-base font-bold text-heading">{title}</strong>
      <button
        type="button"
        onClick={onAction}
        className="mt-4 inline-flex h-9 items-center gap-2 rounded-xl bg-primary px-5 text-sm font-semibold text-white hover:bg-primary-hover"
      >
        <Plus size={14} /> {action}
      </button>
    </div>
  );
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label>
      <span>{label}</span>
      <input value={value} onChange={(e) => onChange(e.currentTarget.value)} />
    </label>
  );
}

function NumberField({ label, value, optional, onChange }: { label: string; value: string; optional?: boolean; onChange: (v: number | undefined) => void }) {
  return (
    <label>
      <span>{label}</span>
      <input
        type="number"
        value={value}
        placeholder={optional ? "off" : undefined}
        onChange={(e) => {
          const raw = e.currentTarget.value;
          onChange(raw === "" ? undefined : Number(raw));
        }}
      />
    </label>
  );
}

function SelectField({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <label>
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.currentTarget.value)}>
        {options.map((o) => <option key={o || "none"} value={o}>{o || "unset"}</option>)}
      </select>
    </label>
  );
}

function BoolField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex h-10 items-center gap-2">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.currentTarget.checked)} className="h-4 w-4 accent-primary" />
      <span className="text-sm font-semibold text-muted">{label}</span>
    </label>
  );
}

export default App;
