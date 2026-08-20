import { useEffect, useState } from "react";
import { collectorApi, type PublicSettings } from "../api";

function SecretField({
  label,
  configured,
  hint,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  configured: boolean;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="settings-field">
      <span>{label}</span>
      <input
        type="password"
        autoComplete="off"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={configured ? `已配置 ${hint ?? "••••"} — 留空保持不变，输入则覆盖` : placeholder ?? "粘贴 token"}
      />
      <small>{configured ? `当前：${hint ?? "••••"}（脱敏）` : "尚未配置"}</small>
    </label>
  );
}

export function SettingsView() {
  const [settings, setSettings] = useState<PublicSettings>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();

  const [hostId, setHostId] = useState("");
  const [hostLabel, setHostLabel] = useState("");
  const [role, setRole] = useState<"node" | "hub" | "both">("node");
  const [gatewayName, setGatewayName] = useState("");
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [gatewayToken, setGatewayToken] = useState("");
  const [serverHost, setServerHost] = useState("127.0.0.1");
  const [serverPort, setServerPort] = useState("47123");
  const [standaloneCli, setStandaloneCli] = useState<"enabled" | "disabled">("enabled");

  const [pairCode, setPairCode] = useState("");
  const [pairNodeUrl, setPairNodeUrl] = useState("http://192.168.1.10:47123");
  const [offerCode, setOfferCode] = useState<string>();
  const [offerExpiresAt, setOfferExpiresAt] = useState<number>();

  const load = async () => {
    try {
      const next = await collectorApi.settings();
      setSettings(next);
      setHostId(next.host.id);
      setHostLabel(next.host.label);
      setRole(next.role);
      setGatewayName(next.gateway.name);
      setGatewayUrl(next.gateway.url);
      setServerHost(next.server.host);
      setServerPort(String(next.server.port));
      setStandaloneCli(next.localSources.standaloneCli);
      setGatewayToken("");
      if (next.pairing.active) {
        setOfferCode(next.pairing.active.code);
        setOfferExpiresAt(next.pairing.active.expiresAt);
      }
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    setSaving(true);
    setMessage(undefined);
    try {
      const patch: Parameters<typeof collectorApi.saveSettings>[0] = {
        host: { id: hostId.trim(), label: hostLabel.trim() },
        role,
        gateway: {
          name: gatewayName.trim(),
          url: gatewayUrl.trim(),
          ...(gatewayToken.trim() ? { token: gatewayToken.trim() } : {}),
        },
        server: {
          host: serverHost.trim(),
          port: Number(serverPort),
        },
        localSources: { standaloneCli },
      };
      const next = await collectorApi.saveSettings(patch);
      setSettings(next);
      setGatewayToken("");
      setMessage(next.restartRequired ? "已保存。请重启 Collector 使绑定地址 / role / hub 节点生效。" : "已保存。");
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const createOffer = async () => {
    setMessage(undefined);
    try {
      const offer = await collectorApi.pairingOffer();
      setOfferCode(offer.code);
      setOfferExpiresAt(offer.expiresAt);
      setMessage(
        offer.createdToken
          ? "已生成配对码，并创建了 Node 共享密钥。若刚改为 LAN 绑定，请重启后再让 Hub 来认领。"
          : "已生成配对码。",
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const claimPair = async () => {
    setMessage(undefined);
    try {
      const result = await collectorApi.pairingClaim({ code: pairCode.trim(), nodeUrl: pairNodeUrl.trim() });
      setSettings(result.settings);
      setPairCode("");
      setMessage(`已配对节点 ${result.node.id}。请重启 Collector（hub）以开始 fan-in。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="surface view-surface settings-view">
      <div className="view-heading">
        <div>
          <span className="eyebrow">OPERATOR SETUP</span>
          <h1>Settings</h1>
        </div>
        {settings?.restartRequired ? <span className="count-chip">Restart required</span> : null}
      </div>

      {error ? (
        <div className="connection-banner">
          <span />
          {error}
          <button type="button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : null}
      {message ? <p className="settings-banner">{message}</p> : null}

      <div className="settings-grid">
        <article className="settings-card">
          <h2>本机身份</h2>
          <label className="settings-field">
            <span>Host ID</span>
            <input value={hostId} onChange={(event) => setHostId(event.target.value)} />
          </label>
          <label className="settings-field">
            <span>显示名</span>
            <input value={hostLabel} onChange={(event) => setHostLabel(event.target.value)} />
          </label>
          <label className="settings-field">
            <span>角色</span>
            <select value={role} onChange={(event) => setRole(event.target.value as "node" | "hub" | "both")}>
              <option value="node">node — 采集本机 Gateway</option>
              <option value="hub">hub — 汇聚远程 node</option>
              <option value="both">both — 本机采集 + 可配对远程</option>
            </select>
          </label>
        </article>

        <article className="settings-card">
          <h2>OpenClaw Gateway</h2>
          <label className="settings-field">
            <span>名称</span>
            <input value={gatewayName} onChange={(event) => setGatewayName(event.target.value)} />
          </label>
          <label className="settings-field">
            <span>URL</span>
            <input value={gatewayUrl} onChange={(event) => setGatewayUrl(event.target.value)} placeholder="ws://127.0.0.1:18789" />
          </label>
          <SecretField
            label="Gateway token"
            configured={Boolean(settings?.gateway.token.configured)}
            hint={settings?.gateway.token.hint}
            value={gatewayToken}
            onChange={setGatewayToken}
            placeholder="录入本机 gateway.auth.token"
          />
        </article>

        <article className="settings-card">
          <h2>HTTP 绑定</h2>
          <label className="settings-field">
            <span>Listen host</span>
            <input value={serverHost} onChange={(event) => setServerHost(event.target.value)} placeholder="127.0.0.1 或 0.0.0.0" />
            <small>非 loopback 时会自动生成 Node 共享密钥，供 Hub 访问。</small>
          </label>
          <label className="settings-field">
            <span>Port</span>
            <input value={serverPort} onChange={(event) => setServerPort(event.target.value)} />
          </label>
          <p className="settings-muted">
            Node 共享密钥：{settings?.server.token.configured ? settings.server.token.hint : "未生成"} · LAN 暴露：
            {settings?.server.lanExposed ? "是" : "否"}
          </p>
          <label className="settings-field">
            <span>独立 Claude / Codex CLI</span>
            <select
              value={standaloneCli}
              onChange={(event) => setStandaloneCli(event.target.value as "enabled" | "disabled")}
            >
              <option value="enabled">启用</option>
              <option value="disabled">关闭</option>
            </select>
          </label>
        </article>

        <article className="settings-card">
          <h2>生成配对码（在 Node 上）</h2>
          <p className="settings-muted">生成一次性配对码。把码和本机 `http://IP:端口` 交给 Hub。</p>
          <button type="button" className="settings-primary" onClick={() => void createOffer()}>
            生成配对码
          </button>
          {offerCode ? (
            <div className="pairing-code-panel">
              <code>{offerCode}</code>
              <small>
                有效至 {offerExpiresAt ? new Date(offerExpiresAt).toLocaleTimeString() : "—"}
              </small>
            </div>
          ) : null}
        </article>

        <article className="settings-card">
          <h2>认领节点（在 Hub 上）</h2>
          <label className="settings-field">
            <span>配对码</span>
            <input value={pairCode} onChange={(event) => setPairCode(event.target.value.toUpperCase())} placeholder="A7K2-9MQX" />
          </label>
          <label className="settings-field">
            <span>Node URL</span>
            <input value={pairNodeUrl} onChange={(event) => setPairNodeUrl(event.target.value)} placeholder="http://192.168.1.10:47123" />
          </label>
          <button type="button" className="settings-primary" onClick={() => void claimPair()}>
            配对并写入配置
          </button>
          <ul className="settings-node-list">
            {(settings?.hub.nodes ?? []).map((node) => (
              <li key={node.id}>
                <strong>{node.label ?? node.id}</strong>
                <span>{node.url}</span>
                <small>{node.token.configured ? node.token.hint : "无密钥"}</small>
              </li>
            ))}
          </ul>
        </article>
      </div>

      <div className="settings-actions">
        <button type="button" className="settings-primary" disabled={saving} onClick={() => void save()}>
          {saving ? "保存中…" : "保存配置"}
        </button>
        <button type="button" onClick={() => void load()}>
          重新加载
        </button>
      </div>

      {settings ? (
        <p className="settings-paths">
          配置文件 <code>{settings.paths.config}</code> · 密钥文件 <code>{settings.paths.secrets}</code>（token
          只写入密钥文件，API 永不回显明文）
        </p>
      ) : null}
    </section>
  );
}
