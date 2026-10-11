import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { collectorApi, type PublicSettings } from "../api";
import {
  claimAndEnableHub,
  connectionAddress,
  encodeConnectionPackage,
  expiryCountdown,
  intentForRole,
  isLocalAddress,
  machineConnectionState,
  parseConnectionPackage,
  roleForIntent,
  shareReadiness,
  settingsError,
  suggestedConnectionAddress,
  type ConnectionPackage,
} from "../lib/settings-flow";
import { useCollector } from "../state/collector-context";
import { Link, useLocation } from "../router";
import "./settings.css";

function DeviceIcon({ fleet = false }: { fleet?: boolean }) {
  return (
    <svg className="setup-device-icon" viewBox={fleet ? "0 0 124 70" : "0 0 72 70"} fill="none" aria-hidden="true">
      {fleet ? <><rect x="2" y="5" width="27" height="18" rx="3" /><path d="M15 23v6m-8 0h16M36 17l20 13M36 52l20-13" strokeDasharray="3 4" /><rect x="2" y="40" width="27" height="18" rx="3" /><path d="M15 58v6m-8 0h16" /></> : null}
      <rect x={fleet ? 63 : 7} y="12" width="56" height="37" rx="4" /><path d={fleet ? "M91 49v11m-16 0h32" : "M35 49v11M19 60h32"} />
    </svg>
  );
}

function SourceIcon() {
  return <svg className="setup-source-icon" viewBox="0 0 64 64" fill="none" aria-hidden="true"><rect x="13" y="13" width="38" height="38" rx="12" /><path d="M24 22l-7 10 7 10m16-20 7 10-7 10M35 19l-6 26" /></svg>;
}

function ArchiveIcon() {
  return <svg className="setup-archive-icon" viewBox="0 0 80 80" fill="none" aria-hidden="true"><rect x="12" y="8" width="56" height="36" rx="4" /><path d="M31 44v8m18-8v8M23 52h34" /><rect x="19" y="60" width="42" height="12" rx="3" /><path d="M27 22h26M27 30h18M28 66h24" /></svg>;
}

function ShortState({ tone = "neutral", children }: { tone?: "good" | "warn" | "bad" | "neutral"; children: ReactNode }) {
  return <span className="setup-state" data-tone={tone}><span aria-hidden="true">{tone === "good" ? "✓" : tone === "bad" ? "!" : tone === "warn" ? "◷" : "○"}</span>{children}</span>;
}

function SecretField({ configured, hint, value, onChange, disabled }: { configured: boolean; hint?: string; value: string; onChange: (value: string) => void; disabled: boolean }) {
  const [replacing, setReplacing] = useState(!configured);
  useEffect(() => { if (!value) setReplacing(!configured); }, [configured, value]);
  return (
    <div className="setup-field">
      <span>Gateway token</span>
      {configured && !replacing ? (
        <div className="setup-secret"><code>{hint ?? "••••"}</code><ShortState tone="good">已配置</ShortState><button type="button" disabled={disabled} onClick={() => setReplacing(true)}>更换</button></div>
      ) : (
        <><input aria-label="Gateway token" type="password" autoComplete="off" value={value} onChange={(event) => onChange(event.target.value)} placeholder="粘贴 Gateway token" disabled={disabled} />
          {configured ? <button type="button" className="setup-text-button" disabled={disabled} onClick={() => { onChange(""); setReplacing(false); }}>保留现有 token</button> : <small>尚未配置</small>}</>
      )}
    </div>
  );
}

type SetupError = ReturnType<typeof settingsError>;

const CONNECTION_LABELS = { pending: "待重启", connecting: "正在连接", reachable: "HTTP 可达", unreachable: "不可达", unknown: "状态未确认" } as const;

export function SettingsView() {
  const { status, live } = useCollector();
  const { searchParams } = useLocation();
  const archiveSection = searchParams.get("section") === "archive";
  const [settings, setSettings] = useState<PublicSettings>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "offer" | "claim" | "role">();
  const [error, setError] = useState<SetupError>();
  const [message, setMessage] = useState<string>();
  const [now, setNow] = useState(Date.now);
  const [hostId, setHostId] = useState("");
  const [hostLabel, setHostLabel] = useState("");
  const [role, setRole] = useState<PublicSettings["role"]>("node");
  const [gatewayName, setGatewayName] = useState("");
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [gatewayToken, setGatewayToken] = useState("");
  const [serverHost, setServerHost] = useState("127.0.0.1");
  const [serverPort, setServerPort] = useState("47123");
  const [standaloneCli, setStandaloneCli] = useState<"enabled" | "disabled">("enabled");
  const [transcriptSync, setTranscriptSync] = useState<"enabled" | "disabled">("disabled");
  const [candidateUrl, setCandidateUrl] = useState("");
  const [incomingPackage, setIncomingPackage] = useState("");
  const [copied, setCopied] = useState(false);
  const [joinedNode, setJoinedNode] = useState<string>();

  const hydrate = useCallback((next: PublicSettings) => {
    setSettings(next);
    setHostId(next.host.id);
    setHostLabel(next.host.label);
    setRole(next.role);
    setGatewayName(next.gateway.name);
    setGatewayUrl(next.gateway.url);
    setGatewayToken("");
    setServerHost(next.server.host);
    setServerPort(String(next.server.port));
    setStandaloneCli(next.localSources.standaloneCli);
    setTranscriptSync(next.storage.transcriptSync);
    const runtime = next.runtime;
    if (runtime) setCandidateUrl((current) => current || suggestedConnectionAddress(runtime.server.host, runtime.server.port, window.location.hostname));
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      hydrate(await collectorApi.settings());
      setError(undefined);
    } catch (cause) {
      setError(settingsError(cause, "设置无法加载"));
    } finally {
      setLoading(false);
    }
  }, [hydrate]);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2200);
    return () => window.clearTimeout(timer);
  }, [copied]);
  // Read-only polling observes a real restart or consumption of the in-memory code.
  // It never overwrites edits the operator is making.
  useEffect(() => {
    let active = true;
    const timer = window.setInterval(() => {
      if (busy) return;
      void collectorApi.settings().then((next) => {
        if (!active) return;
        setSettings(next);
        if (!next.restartRequired) setMessage((current) => current?.includes("待重启") ? undefined : current);
      }).catch(() => { /* Keep the last saved state; live status marks stale evidence. */ });
    }, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [busy]);

  const intent = intentForRole(role);
  const runtime = settings?.runtime;
  const dirty = Boolean(settings && (hostId.trim() !== settings.host.id || hostLabel.trim() !== settings.host.label
    || role !== settings.role || gatewayName.trim() !== settings.gateway.name || gatewayUrl.trim() !== settings.gateway.url
    || Boolean(gatewayToken.trim()) || serverHost.trim() !== settings.server.host || Number(serverPort) !== settings.server.port
    || standaloneCli !== settings.localSources.standaloneCli || transcriptSync !== settings.storage.transcriptSync));
  const archiveDirty = Boolean(settings && transcriptSync !== settings.storage.transcriptSync);
  const archiveCanSave = Boolean(settings && runtime && !busy && archiveDirty && runtime.role !== "hub");
  const readiness = shareReadiness(settings, role, dirty);
  const activeOffer = settings?.pairing.active;
  const offerValid = Boolean(activeOffer && activeOffer.expiresAt > now && readiness === "ready");
  const address = useMemo(() => {
    if (!candidateUrl.trim()) return { error: undefined, value: undefined };
    try { return { value: connectionAddress(candidateUrl), error: undefined }; }
    catch (cause) { return { value: undefined, error: cause instanceof Error ? cause.message : String(cause) }; }
  }, [candidateUrl]);
  const preview = useMemo(() => {
    if (!incomingPackage.trim()) return { value: undefined, error: undefined };
    try { return { value: parseConnectionPackage(incomingPackage, now), error: undefined }; }
    catch (cause) { return { value: undefined, error: cause instanceof Error ? cause.message : String(cause) }; }
  }, [incomingPackage, now]);
  const evidenceFresh = live.state === "open" && Boolean(status && runtime && status.process.startedAt === runtime.startedAt);
  const runtimeCollects = runtime && intentForRole(runtime.role) === "collect";
  const gatewayKnown = Boolean(evidenceFresh && runtimeCollects);
  const gatewayOnline = gatewayKnown && Boolean(status?.gateway.connected);
  const draftLan = !isLocalAddress(serverHost.trim());
  const canSave = settings && !busy && dirty && (role !== "hub" || settings.hub.nodes.length > 0);

  const save = async (roleOnly = false) => {
    setBusy(roleOnly ? "role" : "save");
    setError(undefined);
    setMessage(undefined);
    try {
      const next = await collectorApi.saveSettings(roleOnly ? { role: "hub" } : {
        host: { id: hostId.trim(), label: hostLabel.trim() }, role,
        gateway: { name: gatewayName.trim(), url: gatewayUrl.trim(), ...(gatewayToken.trim() ? { token: gatewayToken.trim() } : {}) },
        server: { host: serverHost.trim(), port: Number(serverPort) }, localSources: { standaloneCli },
        storage: { transcriptSync },
      });
      if (roleOnly) {
        // Recovering the role must not discard unrelated Advanced edits.
        setSettings(next);
        setRole("hub");
      } else {
        // Use the canonical saved values (URLs and labels may be normalized).
        hydrate(next);
      }
      setMessage(next.restartRequired ? "已保存 · 待重启" : "已保存");
    } catch (cause) {
      setError(settingsError(cause));
    } finally { setBusy(undefined); }
  };

  const saveArchive = async () => {
    if (!archiveCanSave) return;
    setBusy("save");
    setError(undefined);
    setMessage(undefined);
    try {
      const next = await collectorApi.saveSettings({ storage: { transcriptSync } });
      // Archive consent cannot submit or discard hidden machine drafts.
      setSettings(next);
      setTranscriptSync(next.storage.transcriptSync);
      setMessage(next.restartRequired ? "归档设置已保存 · 待重启" : "归档设置已保存");
    } catch (cause) {
      setError(settingsError(cause));
    } finally { setBusy(undefined); }
  };

  const createConnection = async (copy = false) => {
    if (readiness !== "ready" || !address.value) return;
    setBusy("offer");
    setError(undefined);
    setMessage(undefined);
    setCopied(false);
    try {
      const offer = await collectorApi.pairingOffer();
      const next = await collectorApi.settings();
      setSettings(next);
      // A code is never offered with pending startup changes.
      if (offer.restartRequired || next.restartRequired) throw new Error("pairing_restart_required");
      setNow(Date.now());
      if (copy) {
        try {
          await navigator.clipboard.writeText(encodeConnectionPackage({ version: 1, nodeUrl: address.value, code: offer.code, label: offer.label, hostId: offer.hostId, expiresAt: offer.expiresAt }));
          setCopied(true);
        } catch (cause) { setError(settingsError(cause, "复制未完成，请允许剪贴板访问后重试")); }
      }
    } catch (cause) {
      setError(settingsError(cause));
      try { setSettings(await collectorApi.settings()); } catch { /* Existing state stays visible. */ }
    } finally { setBusy(undefined); }
  };

  const copyConnection = async () => {
    if (!activeOffer || !offerValid || !address.value) return;
    const connection: ConnectionPackage = { version: 1, nodeUrl: address.value, ...activeOffer };
    try {
      await navigator.clipboard.writeText(encodeConnectionPackage(connection));
      setCopied(true);
      setError(undefined);
    } catch (cause) { setError(settingsError(cause, "复制未完成，请允许剪贴板访问后重试")); }
  };

  const connectMachine = async () => {
    if (!preview.value || busy) return;
    setBusy("claim");
    setError(undefined);
    setMessage(undefined);
    try {
      const result = await claimAndEnableHub(collectorApi, preview.value, (joined) => {
        setSettings(joined.settings);
        setJoinedNode(joined.node.id);
        setRole("hub");
        setIncomingPackage("");
        setMessage(`${joined.node.label || joined.node.id} · 已加入配置`);
        setBusy("role");
      });
      setSettings(result.settings);
      if (result.roleSaveError) {
        setError(settingsError(result.roleSaveError, "采集机已加入；汇总设置尚未保存"));
      } else { setMessage("已加入配置 · 待重启"); }
    } catch (cause) { setError(settingsError(cause)); }
    finally { setBusy(undefined); }
  };

  return (
    <section className="surface view-surface settings-setup" aria-busy={loading || Boolean(busy)}>
      <div className="view-heading"><div><span className="eyebrow">这台机器</span><h1>Settings</h1></div>
        <button type="button" className="setup-text-button" onClick={() => void reload()} disabled={loading || Boolean(busy)}>↻ 重新加载</button>
      </div>
      {loading && !settings ? <div className="setup-loading" role="status">正在读取本机设置…</div> : null}
      {error ? <div className="setup-error" role="alert"><strong>{error.message}</strong><details><summary>错误详情</summary><code>{error.detail}</code></details>{!settings ? <button type="button" onClick={() => void reload()}>重新加载</button> : null}</div> : null}
      {settings ? <>
        <nav className="setup-sections" aria-label="设置分类">
          <Link to="/settings" aria-current={!archiveSection ? "page" : undefined}>机器连接</Link>
          <Link to="/settings?section=archive" aria-current={archiveSection ? "page" : undefined}>正文归档</Link>
        </nav>
        {archiveSection ? <section className="setup-archive" aria-labelledby="setup-archive-title">
          <div className="setup-archive-heading"><ArchiveIcon /><div><h2 id="setup-archive-title">正文归档</h2><span>保存在本机</span></div></div>
          <div className="setup-archive-choice">
            <div><strong id="setup-archive-label">本地保存正文</strong><small id="setup-archive-note">关闭不删除已存正文</small></div>
            <span className="setup-archive-draft">{transcriptSync === "enabled" ? "开启" : "关闭"}</span>
            <button type="button" className="setup-archive-switch" role="switch" aria-labelledby="setup-archive-label" aria-describedby="setup-archive-note" aria-checked={transcriptSync === "enabled"} disabled={Boolean(busy) || runtime?.role === "hub"} onClick={() => setTranscriptSync((current) => current === "enabled" ? "disabled" : "enabled")}><span /></button>
          </div>
          {runtime?.role === "hub" ? <ShortState>汇总机不采集会话正文</ShortState> : null}
          <div className="setup-archive-runtime" role="status">
            <span>当前运行</span><ShortState tone={runtime?.role !== "hub" && runtime?.storage.transcriptSync === "enabled" ? "good" : "neutral"}>{runtime?.role === "hub" ? "汇总模式" : runtime ? runtime.storage.transcriptSync === "enabled" ? "归档已开启" : "归档已关闭" : "状态未确认"}</ShortState>
            {settings.storage.transcriptSync !== runtime?.storage.transcriptSync ? <><span>已保存</span><ShortState tone="warn">{settings.storage.transcriptSync === "enabled" ? "开启" : "关闭"} · 待重启</ShortState></> : settings.restartRequired ? <ShortState tone="warn">设置待重启</ShortState> : <ShortState>配置已应用</ShortState>}
          </div>
          <div className="setup-archive-actions">
            {archiveDirty ? <ShortState tone="warn">有未保存更改</ShortState> : <span />}
            <button type="button" className="setup-primary" disabled={!archiveCanSave} onClick={() => void saveArchive()}>{busy === "save" ? "保存中…" : "保存更改"}</button>
          </div>
          {message ? <div className="setup-feedback" role="status">{message}</div> : null}
        </section> : <>
        <div className="setup-intents" role="group" aria-label="这台机器的用途">
          <button type="button" className="setup-intent" aria-pressed={intent === "collect"} disabled={Boolean(busy)} onClick={() => setRole(roleForIntent(role, "collect", settings.role))}>
            <DeviceIcon /><span><strong>本机采集</strong><small>本机 OpenClaw → 看板</small></span><span className="setup-choice" aria-hidden="true">{intent === "collect" ? "●" : "○"}</span>
          </button>
          <button type="button" className="setup-intent" aria-pressed={intent === "aggregate"} disabled={Boolean(busy)} onClick={() => setRole(roleForIntent(role, "aggregate"))}>
            <DeviceIcon fleet /><span><strong>汇总多机</strong><small>多台采集机 → 看板</small></span><span className="setup-choice" aria-hidden="true">{intent === "aggregate" ? "●" : "○"}</span>
          </button>
        </div>
        <div className="setup-applied" role="status">
          <span>当前运行：<b>{runtime ? intentForRole(runtime.role) === "collect" ? "本机采集" : "汇总多机" : "状态未确认"}</b></span>
          {settings.restartRequired ? <ShortState tone="warn">已保存 · 待重启</ShortState> : runtime ? <ShortState>配置已应用</ShortState> : null}
          {settings.restartRequired && runtime && intentForRole(runtime.role) !== intentForRole(settings.role) ? <span>待应用：<b>{intentForRole(settings.role) === "collect" ? "本机采集" : "汇总多机"}</b></span> : null}
          {dirty ? <><ShortState tone="warn">有未保存更改</ShortState><button type="button" className="setup-primary" disabled={!canSave} onClick={() => void save()}>{busy === "save" ? "保存中…" : "保存更改"}</button></> : null}
          {role === "hub" && settings.hub.nodes.length === 0 && dirty ? <small>先加入采集机</small> : null}
        </div>
        {message ? <div className="setup-feedback" role="status">{message}</div> : null}

        {intent === "collect" ? <div className="setup-collect">
          <ol className="setup-steps" aria-label="分享本机的步骤">
            <li data-done={Boolean(runtime?.server.lanExposed)}><span>{runtime?.server.lanExposed ? "✓" : "1"}</span>网络</li>
            <li data-done={readiness === "ready"}><span>{readiness === "ready" ? "✓" : "2"}</span>配置已应用</li>
            <li data-current={readiness === "ready"}><span>{offerValid ? "✓" : "3"}</span>分享连接</li>
          </ol>
          <div className="setup-network">
            <span>访问范围</span><div role="group" aria-label="HTTP 访问范围"><button type="button" aria-pressed={!draftLan} disabled={Boolean(busy)} onClick={() => setServerHost("127.0.0.1")}>本地访问</button><button type="button" aria-pressed={draftLan} disabled={Boolean(busy)} onClick={() => setServerHost("0.0.0.0")}>局域网访问</button></div>
            <ShortState tone={settings.restartRequired ? "warn" : "neutral"}>{settings.restartRequired ? "待重启" : runtime?.server.lanExposed ? "局域网绑定已应用" : "仅本机访问"}</ShortState>
          </div>
          <div className="setup-topology" aria-label="本机采集连接状态">
            <div className="setup-object"><SourceIcon /><strong>{runtime?.gateway.name || "OpenClaw"}</strong><small>Gateway 数据源</small><ShortState tone={gatewayOnline ? "good" : gatewayKnown ? "bad" : "neutral"}>{gatewayOnline ? "数据源在线" : gatewayKnown ? "数据源离线" : "状态未确认"}</ShortState></div>
            <span className="setup-wire" data-online={gatewayOnline} aria-hidden="true" />
            <div className="setup-object"><DeviceIcon /><strong>{runtime?.host.label || settings.host.label}</strong><small>当前采集机</small><ShortState>{runtimeCollects ? "HTTP 本机可访问" : "用途待应用"}</ShortState></div>
            <span className="setup-wire setup-wire-candidate" aria-hidden="true" />
            <div className="setup-object setup-object-remote"><DeviceIcon /><strong>另一台机器</strong><ShortState>尚未验证连接</ShortState></div>
          </div>
          <div className="setup-connection-object">
            <label className="setup-field setup-address"><span>供另一台机器访问的地址</span><input type="url" value={candidateUrl} onChange={(event) => { setCandidateUrl(event.target.value); setCopied(false); }} placeholder={`http://192.168.1.10:${runtime?.server.port ?? serverPort}`} aria-invalid={Boolean(address.error)} aria-describedby={address.error ? "setup-address-error" : "setup-address-note"} disabled={Boolean(busy)} />
              {address.error ? <small id="setup-address-error" className="setup-field-error">{address.error}</small> : <small id="setup-address-note">候选地址 · 待对端验证 · 只读</small>}
            </label>
            <div className="setup-package-fact"><span>一次性码</span><code>{offerValid ? activeOffer?.code : activeOffer && activeOffer.expiresAt <= now ? "已过期" : "—"}</code></div>
            <div className="setup-package-fact"><span>剩余时间</span><strong>{offerValid && activeOffer ? expiryCountdown(activeOffer.expiresAt, now) : "—"}</strong></div>
          </div>
          <div className="setup-share-actions">
            {readiness === "restart" ? <ShortState tone="warn">重启 Collector 后继续</ShortState> : readiness === "network" ? <ShortState>准备局域网访问</ShortState> : readiness === "unsaved" ? <ShortState tone="warn">先保存更改并重启</ShortState> : <span />}
            {offerValid ? <button type="button" className="setup-text-button" disabled={Boolean(busy)} onClick={() => void createConnection()}>↻ 新连接</button> : null}
            <button type="button" className="setup-primary" disabled={readiness !== "ready" || !address.value || Boolean(busy)} onClick={() => void (offerValid ? copyConnection() : createConnection(true))}>{busy === "offer" ? "准备连接…" : copied ? "✓ 已复制" : "▣ 复制连接"}</button>
          </div>
        </div> : <div className="setup-aggregate">
          <div className="setup-aggregate-heading"><DeviceIcon fleet /><div><h2>加入采集机</h2><ShortState>兑换后保存汇总设置 · 重启后连接</ShortState></div></div>
          <label className="setup-field"><span>连接包</span><textarea value={incomingPackage} onChange={(event) => setIncomingPackage(event.target.value)} placeholder="粘贴采集机复制的连接" rows={3} disabled={Boolean(busy)} aria-invalid={Boolean(preview.error)} aria-describedby={preview.error ? "setup-preview-error" : undefined} /></label>
          {preview.error ? <div id="setup-preview-error" className="setup-field-error" role="status">{preview.error}</div> : null}
          {preview.value ? <div className="setup-preview"><DeviceIcon /><div><strong>{preview.value.label}</strong><code>{preview.value.nodeUrl}</code><ShortState>候选设备 · 待验证</ShortState></div><span>{expiryCountdown(preview.value.expiresAt, now)}</span><button type="button" className="setup-primary" disabled={Boolean(busy)} onClick={() => void connectMachine()}>{settings.hub.nodes.some((node) => node.id === preview.value!.hostId) ? "更新连接" : "连接"}</button></div> : null}
          {joinedNode && settings.role !== "hub" ? <div className="setup-recovery"><ShortState tone="warn">采集机已加入配置</ShortState><button type="button" className="setup-primary" disabled={Boolean(busy)} onClick={() => void save(true)}>{busy === "role" ? "保存中…" : "保存汇总设置"}</button></div> : null}
          {busy === "claim" || busy === "role" ? <div className="setup-feedback" role="status">{busy === "claim" ? "正在兑换连接…" : "正在保存汇总设置…"}</div> : null}
          <div className="setup-machines" aria-label="已加入的采集机">
            {settings.hub.nodes.length === 0 ? <div className="setup-no-machines"><DeviceIcon /><strong>等待加入采集机</strong></div> : settings.hub.nodes.map((node) => {
              const connectionState = machineConnectionState(settings, node.id, status, evidenceFresh);
              const observed = evidenceFresh && connectionState === "reachable" ? status?.hosts?.find((host) => host.id === node.id) : undefined;
              return <article className="setup-machine" key={node.id}><DeviceIcon /><div><strong>{node.label || node.id}</strong><code>{node.url}</code><div className="setup-machine-states"><ShortState tone={connectionState === "reachable" ? "good" : connectionState === "unreachable" ? "bad" : connectionState === "pending" ? "warn" : "neutral"}>{CONNECTION_LABELS[connectionState]}</ShortState><ShortState tone={observed?.gatewayConnected === true ? "good" : observed?.gatewayConnected === false ? "bad" : "neutral"}>{observed?.gatewayConnected === true ? "数据源在线" : observed?.gatewayConnected === false ? "数据源离线" : "数据源状态未确认"}</ShortState></div></div></article>;
            })}
          </div>
        </div>}

        <details className="setup-advanced">
          <summary><span aria-hidden="true">⚙</span> 高级设置 <span aria-hidden="true">⌄</span></summary>
          <div className="setup-advanced-grid">
            <fieldset><legend>本机身份</legend><label className="setup-field"><span>显示名</span><input value={hostLabel} onChange={(event) => setHostLabel(event.target.value)} disabled={Boolean(busy)} /></label><label className="setup-field"><span>Host ID</span><input value={hostId} onChange={(event) => setHostId(event.target.value)} disabled={Boolean(busy)} /></label>
              <label className="setup-field"><span>兼容角色</span><select value={role} onChange={(event) => setRole(event.target.value as PublicSettings["role"])} disabled={Boolean(busy)}><option value="node">node · 本机采集</option><option value="hub">hub · 汇总多机</option><option value="both">both · 本机采集（兼容）</option></select></label>{role === "both" ? <ShortState>both 当前仅采集本机</ShortState> : null}
            </fieldset>
            <fieldset><legend>OpenClaw Gateway</legend><label className="setup-field"><span>名称</span><input value={gatewayName} onChange={(event) => setGatewayName(event.target.value)} disabled={Boolean(busy)} /></label><label className="setup-field"><span>URL</span><input type="url" value={gatewayUrl} onChange={(event) => setGatewayUrl(event.target.value)} placeholder="ws://127.0.0.1:18789" disabled={Boolean(busy)} /></label><SecretField configured={settings.gateway.token.configured} hint={settings.gateway.token.hint} value={gatewayToken} onChange={setGatewayToken} disabled={Boolean(busy)} /></fieldset>
            <fieldset><legend>HTTP 绑定</legend><label className="setup-field"><span>监听地址</span><input value={serverHost} onChange={(event) => setServerHost(event.target.value)} disabled={Boolean(busy)} /></label><label className="setup-field"><span>端口</span><input type="number" min="1" max="65535" value={serverPort} onChange={(event) => setServerPort(event.target.value)} disabled={Boolean(busy)} /></label><ShortState>{settings.server.token.configured ? "共享密钥已配置" : "共享密钥未配置"}</ShortState><label className="setup-field"><span>独立 Claude / Codex CLI</span><select value={standaloneCli} onChange={(event) => setStandaloneCli(event.target.value as "enabled" | "disabled")} disabled={Boolean(busy)}><option value="enabled">启用</option><option value="disabled">关闭</option></select></label></fieldset>
          </div>
          <div className="setup-advanced-actions"><button type="button" className="setup-primary" disabled={!canSave} onClick={() => void save()}>{busy === "save" ? "保存中…" : "保存更改"}</button><span>保存后重启 Collector 应用</span></div>
          <dl className="setup-paths"><div><dt>配置文件</dt><dd><code>{settings.paths.config}</code></dd></div><div><dt>密钥文件</dt><dd><code>{settings.paths.secrets}</code></dd></div></dl>
        </details>
        </>}
      </> : null}
    </section>
  );
}
