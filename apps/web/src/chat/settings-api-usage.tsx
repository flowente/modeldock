import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, CircleAlert, CircleCheck, CircleSlash } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type ApiUsageDay, type ApiUsageEntry, type ApiUsageTotals } from "./chat-api.ts";
import { Card, Feedback, formatDate } from "./Settings.tsx";

const PERIODS = [7, 30, 90] as const;

export function KeyUsage({ id }: { id: string }) {
  const [days, setDays] = useState<number>(30);
  // getTimezoneOffset is minutes *behind* UTC: Italy in summer gives -120.
  const offset = -new Date().getTimezoneOffset();
  const usage = useQuery({ queryKey: ["api-key-usage", id, days, offset], queryFn: () => api.apiKeyUsage(id, days, offset) });
  const data = usage.data;

  return (
    <>
      <a className="md-back-link" href="#/impostazioni/chiavi-api">
        <ArrowLeft size={16} aria-hidden="true" />
        Tutte le chiavi
      </a>
      <div className="md-settings-heading">
        <div>
          <h1>{data?.key.name ?? "Chiave"}</h1>
          {data ? (
            <p>
              <code className="md-key-hint">{data.key.hint}</code> · di {data.key.owner.displayName} · creata {formatDate(data.key.createdAt)} ·{" "}
              {data.key.lastUsedAt ? `usata l'ultima volta ${formatDate(data.key.lastUsedAt)}` : "mai usata"}
            </p>
          ) : null}
        </div>
        <div className="md-segmented" role="group" aria-label="Periodo">
          {PERIODS.map((period) => (
            <button key={period} type="button" aria-pressed={days === period} onClick={() => setDays(period)}>
              {period} giorni
            </button>
          ))}
        </div>
      </div>

      <Feedback error={usage.error} />
      {usage.isPending ? <p className="md-muted">Caricamento…</p> : null}

      {data ? (
        <>
          <Tiles totals={data.totals} />
          <Card title="Giorno per giorno" text="Passa sopra una colonna per vedere i numeri di quel giorno.">
            <DailyChart days={data.daily} />
          </Card>
          <Card title="Per modello">
            {data.byModel.length === 0 ? (
              <p className="md-muted">Nessuna chiamata in questo periodo.</p>
            ) : (
              <div className="md-table-scroll">
                <table className="md-table">
                  <thead>
                    <tr>
                      <th scope="col">Modello</th>
                      <th scope="col" className="md-right">
                        Chiamate
                      </th>
                      <th scope="col" className="md-right">
                        Errori
                      </th>
                      <th scope="col" className="md-right">
                        Token in entrata
                      </th>
                      <th scope="col" className="md-right">
                        Token in uscita
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byModel.map((row) => (
                      <tr key={row.model}>
                        <td>
                          <code className="md-model-name">{row.model}</code>
                        </td>
                        <td className="md-right md-num">{formatCount(row.calls)}</td>
                        <td className="md-right md-num">{formatCount(row.errors)}</td>
                        <td className="md-right md-num">{formatCount(row.promptTokens)}</td>
                        <td className="md-right md-num">{formatCount(row.completionTokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <Card title="Ultime chiamate" text="Solo i numeri: ModelDock non conserva le domande né le risposte.">
            {data.recent.length === 0 ? <p className="md-muted">Questa chiave non è ancora stata usata.</p> : <RecentCalls entries={data.recent} />}
          </Card>
        </>
      ) : null}
    </>
  );
}

function Tiles({ totals }: { totals: ApiUsageTotals }) {
  return (
    <div className="md-tiles">
      <div className="md-tile">
        <span className="md-tile-label">Chiamate</span>
        <span className="md-tile-value">{formatCount(totals.calls)}</span>
        <span className="md-tile-note">{totals.errors === 0 ? "nessun errore" : `${formatCount(totals.errors)} con errore`}</span>
      </div>
      <div className="md-tile">
        <span className="md-tile-label">
          <i className="md-swatch" data-series="in" aria-hidden="true" />
          Token in entrata
        </span>
        <span className="md-tile-value">{formatCount(totals.promptTokens)}</span>
        <span className="md-tile-note">quello che il programma manda</span>
      </div>
      <div className="md-tile">
        <span className="md-tile-label">
          <i className="md-swatch" data-series="out" aria-hidden="true" />
          Token in uscita
        </span>
        <span className="md-tile-value">{formatCount(totals.completionTokens)}</span>
        <span className="md-tile-note">quello che il modello risponde</span>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- Chart */

const CHART_HEIGHT = 200;
const PAD = { top: 12, right: 8, bottom: 26, left: 44 };

function DailyChart({ days }: { days: ApiUsageDay[] }) {
  const [metric, setMetric] = useState<"tokens" | "calls">("tokens");
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(280, Math.floor(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const values = days.map((day) => (metric === "tokens" ? day.promptTokens + day.completionTokens : day.calls));
  const max = niceMax(Math.max(0, ...values));
  const innerWidth = width - PAD.left - PAD.right;
  const innerHeight = CHART_HEIGHT - PAD.top - PAD.bottom;
  const band = innerWidth / Math.max(1, days.length);
  const barWidth = Math.max(2, Math.min(24, band - 2));
  const y = (value: number) => PAD.top + innerHeight - (max === 0 ? 0 : (value / max) * innerHeight);
  const ticks = [0, max / 2, max];
  const labelEvery = Math.ceil(days.length / Math.max(2, Math.floor(innerWidth / 70)));
  const empty = values.every((value) => value === 0);
  const hovered = hover === null ? undefined : days[hover];

  return (
    <div className="md-chart">
      <div className="md-chart-bar">
        <div className="md-segmented" role="group" aria-label="Cosa mostrare">
          <button type="button" aria-pressed={metric === "tokens"} onClick={() => setMetric("tokens")}>
            Token
          </button>
          <button type="button" aria-pressed={metric === "calls"} onClick={() => setMetric("calls")}>
            Chiamate
          </button>
        </div>
        {metric === "tokens" ? (
          <ul className="md-legend">
            <li>
              <i className="md-swatch" data-series="in" aria-hidden="true" />
              In entrata
            </li>
            <li>
              <i className="md-swatch" data-series="out" aria-hidden="true" />
              In uscita
            </li>
          </ul>
        ) : null}
      </div>

      <div className="md-chart-plot" ref={box} onMouseLeave={() => setHover(null)}>
        {empty ? (
          <p className="md-chart-empty">Nessuna chiamata in questo periodo.</p>
        ) : (
          <svg width={width} height={CHART_HEIGHT} role="img" aria-label={metric === "tokens" ? "Token al giorno" : "Chiamate al giorno"}>
            {ticks.map((tick) => (
              <g key={tick}>
                <line className="md-grid" x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} />
                <text className="md-axis" x={PAD.left - 8} y={y(tick)} dy="0.32em" textAnchor="end">
                  {formatAxis(tick)}
                </text>
              </g>
            ))}
            {days.map((day, index) => {
              const x = PAD.left + index * band + (band - barWidth) / 2;
              // Counted back from today, so the last day always has its date and none collide.
              const showLabel = (days.length - 1 - index) % labelEvery === 0;
              return (
                <g key={day.day}>
                  {hover === index ? <rect className="md-chart-hover" x={PAD.left + index * band} y={PAD.top} width={band} height={innerHeight} /> : null}
                  {metric === "tokens" ? (
                    <Stack x={x} width={barWidth} base={y(0)} parts={[
                      { series: "in", top: y(day.promptTokens), value: day.promptTokens },
                      { series: "out", top: y(day.promptTokens + day.completionTokens), value: day.completionTokens }
                    ]} />
                  ) : (
                    <Stack x={x} width={barWidth} base={y(0)} parts={[{ series: "calls", top: y(day.calls), value: day.calls }]} />
                  )}
                  {showLabel ? (
                    <text className="md-axis" x={PAD.left + index * band + band / 2} y={CHART_HEIGHT - 8} textAnchor="middle">
                      {shortDay(day.day)}
                    </text>
                  ) : null}
                  {/* The whole column, not just the bar, answers the pointer. */}
                  <rect x={PAD.left + index * band} y={PAD.top} width={band} height={innerHeight} fill="transparent" onMouseEnter={() => setHover(index)} />
                </g>
              );
            })}
          </svg>
        )}
        {hovered && !empty ? (
          <div
            className="md-tooltip"
            style={{ left: tooltipLeft(PAD.left + (hover ?? 0) * band + band / 2, width) }}
            role="status"
          >
            <strong>{longDay(hovered.day)}</strong>
            <span>
              {formatCount(hovered.calls)} {hovered.calls === 1 ? "chiamata" : "chiamate"}
              {hovered.errors ? `, ${formatCount(hovered.errors)} con errore` : ""}
            </span>
            <span>
              <i className="md-swatch" data-series="in" aria-hidden="true" /> {formatCount(hovered.promptTokens)} in entrata
            </span>
            <span>
              <i className="md-swatch" data-series="out" aria-hidden="true" /> {formatCount(hovered.completionTokens)} in uscita
            </span>
          </div>
        ) : null}
      </div>

      <details className="md-chart-table">
        <summary>Vedi i numeri in tabella</summary>
        <div className="md-table-scroll">
          <table className="md-table">
            <thead>
              <tr>
                <th scope="col">Giorno</th>
                <th scope="col" className="md-right">
                  Chiamate
                </th>
                <th scope="col" className="md-right">
                  Errori
                </th>
                <th scope="col" className="md-right">
                  In entrata
                </th>
                <th scope="col" className="md-right">
                  In uscita
                </th>
              </tr>
            </thead>
            <tbody>
              {days.filter((day) => day.calls > 0).map((day) => (
                <tr key={day.day}>
                  <td>{longDay(day.day)}</td>
                  <td className="md-right md-num">{formatCount(day.calls)}</td>
                  <td className="md-right md-num">{formatCount(day.errors)}</td>
                  <td className="md-right md-num">{formatCount(day.promptTokens)}</td>
                  <td className="md-right md-num">{formatCount(day.completionTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

/** Beside the column, never over it: to its right, or to its left near the right edge. */
function tooltipLeft(center: number, width: number): number {
  const tooltipWidth = 180;
  return center + 12 + tooltipWidth <= width ? center + 12 : Math.max(0, center - 12 - tooltipWidth);
}

/** A column grown from the baseline: square at the bottom, 4px round at the top, 2px gaps between parts. */
function Stack({ x, width, base, parts }: { x: number; width: number; base: number; parts: Array<{ series: string; top: number; value: number }> }) {
  const visible = parts.filter((part) => part.value > 0);
  let bottom = base;
  return (
    <>
      {visible.map((part, index) => {
        const last = index === visible.length - 1;
        const gap = index > 0 ? 2 : 0;
        const segmentBottom = bottom - gap;
        const height = Math.max(last ? 1 : 0, segmentBottom - part.top);
        bottom = part.top;
        if (height <= 0) return null;
        const radius = last ? Math.min(4, width / 2, height) : 0;
        return <path key={part.series} className="md-mark" data-series={part.series} d={roundedTop(x, segmentBottom - height, width, height, radius)} />;
      })}
    </>
  );
}

function roundedTop(x: number, y: number, width: number, height: number, radius: number): string {
  if (radius <= 0) return `M${x},${y}h${width}v${height}h${-width}z`;
  return `M${x},${y + height}V${y + radius}Q${x},${y} ${x + radius},${y}H${x + width - radius}Q${x + width},${y} ${x + width},${y + radius}V${y + height}z`;
}

/* ---------------------------------------------------------------- Recent calls */

function RecentCalls({ entries }: { entries: ApiUsageEntry[] }) {
  return (
    <div className="md-table-scroll">
      <table className="md-table">
        <thead>
          <tr>
            <th scope="col">Quando</th>
            <th scope="col">Modello</th>
            <th scope="col">Tipo</th>
            <th scope="col">Esito</th>
            <th scope="col" className="md-right">
              Token
            </th>
            <th scope="col" className="md-right">
              Durata
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, index) => (
            <tr key={`${entry.createdAt}-${index}`}>
              <td className="md-nowrap">{formatDate(entry.createdAt)}</td>
              <td>
                <code className="md-model-name">{entry.model}</code>
              </td>
              <td className="md-nowrap">{entry.endpoint === "embeddings" ? "Embeddings" : entry.streamed ? "Chat, in streaming" : "Chat"}</td>
              <td>
                <Outcome status={entry.status} />
              </td>
              <td className="md-right md-num">
                {entry.promptTokens + entry.completionTokens > 0 ? `${formatCount(entry.promptTokens)} → ${formatCount(entry.completionTokens)}` : "—"}
              </td>
              <td className="md-right md-num">{formatDuration(entry.durationMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Outcome({ status }: { status: number }) {
  if (status < 400) {
    return (
      <span className="md-outcome" data-tone="ok">
        <CircleCheck size={14} aria-hidden="true" />
        Riuscita
      </span>
    );
  }
  if (status === 499) {
    return (
      <span className="md-outcome" data-tone="muted">
        <CircleSlash size={14} aria-hidden="true" />
        Interrotta
      </span>
    );
  }
  const label = status === 404 ? "Modello non disponibile" : status >= 500 ? "Errore del server" : "Richiesta non valida";
  return (
    <span className="md-outcome" data-tone="error" title={`HTTP ${status}`}>
      <CircleAlert size={14} aria-hidden="true" />
      {label}
    </span>
  );
}

/* ---------------------------------------------------------------- Formats */

// Italian leaves four-digit numbers ungrouped (4888 next to 16.033): group them all, for columns that line up.
const COUNT = new Intl.NumberFormat("it-IT", { useGrouping: "always" } as unknown as Intl.NumberFormatOptions);

export function formatCount(value: number): string {
  return COUNT.format(value);
}

function formatAxis(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toLocaleString("it-IT", { maximumFractionDigits: 1 })} M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  return formatCount(value);
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toLocaleString("it-IT", { maximumFractionDigits: 1 })} s`;
}

/** The smallest "round" number at or above the peak, so the top tick reads cleanly. */
function niceMax(value: number): number {
  if (value <= 0) return 0;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate * power >= value) ?? 10;
  // Two ticks above zero: keep the half a whole number.
  const result = step * power;
  return result < 2 ? 2 : result;
}

function shortDay(day: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString("it-IT", { day: "numeric", month: "short" });
}

function longDay(day: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString("it-IT", { weekday: "short", day: "numeric", month: "long" });
}
