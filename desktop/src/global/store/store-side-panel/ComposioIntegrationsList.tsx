import { RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ComposioConnectorSummary } from "../../../shared/types/electron";

const LOGO_BASE_URL = "https://logos.composio.dev/api";

type ConnectorRowProps = {
  connector: ComposioConnectorSummary;
  busy: boolean;
  onToggle: (connector: ComposioConnectorSummary) => void;
};

function ConnectorRow({ connector, busy, onToggle }: ConnectorRowProps) {
  return (
    <div
      className="store-side-panel-row store-side-panel-row--connector"
      data-selected={connector.enabled || undefined}
    >
      <div className="store-side-panel-connector-icon" aria-hidden="true">
        <img
          src={`${LOGO_BASE_URL}/${connector.slug}`}
          alt=""
          loading="lazy"
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
        />
        <span>{connector.name.charAt(0)}</span>
      </div>
      <div className="store-side-panel-row-text">
        <span className="store-side-panel-row-title">{connector.name}</span>
        <span className="store-side-panel-row-meta">
          {connector.enabled
            ? connector.authStatus === "connected"
              ? "Enabled"
              : "Enabled, needs Composio key"
            : "Disabled"}
        </span>
      </div>
      <div className="store-side-panel-row-actions">
        <button
          type="button"
          className="store-side-panel-pill"
          data-active={connector.enabled || undefined}
          disabled={busy}
          onClick={() => onToggle(connector)}
          title={connector.enabled ? "Disable integration" : "Enable integration"}
        >
          {busy ? "Working" : connector.enabled ? "Disable" : "Enable"}
        </button>
      </div>
    </div>
  );
}

export function ComposioIntegrationsList() {
  const [connectors, setConnectors] = useState<ComposioConnectorSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    const electronAPI = window.electronAPI;
    if (!electronAPI) {
      setConnectors([]);
      setError("Desktop integrations are unavailable.");
      setLoading(false);
      return;
    }
    setError(null);
    try {
      setConnectors(await electronAPI.system.listComposioConnectors());
    } catch (refreshError) {
      setError((refreshError as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const filteredConnectors = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return connectors;
    return connectors.filter((connector) =>
      `${connector.name} ${connector.slug}`.toLowerCase().includes(normalized),
    );
  }, [connectors, query]);

  const toggleConnector = async (connector: ComposioConnectorSummary) => {
    const electronAPI = window.electronAPI;
    if (!electronAPI) {
      setError("Desktop integrations are unavailable.");
      return;
    }
    setBusySlug(connector.slug);
    setError(null);
    try {
      if (connector.enabled) {
        await electronAPI.system.disableComposioConnector(connector.slug);
      } else {
        await electronAPI.system.enableComposioConnector(connector.slug);
      }
      await refresh();
    } catch (toggleError) {
      setError((toggleError as Error).message);
    } finally {
      setBusySlug(null);
    }
  };

  return (
    <section className="store-side-panel-integrations">
      <div className="store-side-panel-header">
        <span>Integrations</span>
        <button
          type="button"
          className="store-side-panel-refresh"
          onClick={() => void refresh()}
          disabled={loading}
          title="Refresh"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      <label className="store-side-panel-search">
        <Search size={13} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search integrations"
        />
      </label>

      {error ? <div className="store-side-panel-error">{error}</div> : null}

      {loading && connectors.length === 0 ? (
        <div className="store-side-panel-empty">Loading…</div>
      ) : filteredConnectors.length === 0 ? (
        <div className="store-side-panel-empty">No integrations found.</div>
      ) : (
        <div className="store-side-panel-list store-side-panel-list--integrations">
          {filteredConnectors.map((connector) => (
            <ConnectorRow
              key={connector.slug}
              connector={connector}
              busy={busySlug === connector.slug}
              onToggle={(nextConnector) => void toggleConnector(nextConnector)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
