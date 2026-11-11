import { AgGridReact } from "ag-grid-react";
import { AllCommunityModule, ModuleRegistry, colorSchemeDark, themeQuartz, type ColDef, type GridApi, type GridReadyEvent, type ICellRendererParams } from "ag-grid-community";
import { useEffect, useMemo, useRef } from "react";
import { STAGE_LABEL, clock, label, money } from "../lib/format";
import type { Attempt, Decision } from "../lib/types";
import { DecisionChip, RiskMeter, SignalChip, StageChip } from "./Chips";
import { IconShield } from "./icons";
import { navigate } from "../lib/route";
import { Button } from "./ui";

ModuleRegistry.registerModules([AllCommunityModule]);

/** AG Grid's current Theming API: Quartz, dark colour scheme, tuned to the Purser palette. */
export const purserTheme = themeQuartz.withPart(colorSchemeDark).withParams({
  backgroundColor: "#0c1219",
  foregroundColor: "#e9eff6",
  borderColor: "#1b2633",
  headerBackgroundColor: "#0a0f16",
  headerTextColor: "#6a7a8f",
  headerFontWeight: 600,
  oddRowBackgroundColor: "#0b1118",
  rowHoverColor: "#151f2c",
  selectedRowBackgroundColor: "#1b2740",
  accentColor: "#7c6cff",
  fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif",
  fontSize: 13.5,
  headerFontSize: 11,
  rowBorder: { color: "#16202c" },
  columnBorder: false,
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  spacing: 7,
  inputBackgroundColor: "#070a0f",
  menuBackgroundColor: "#121b26",
});

const mono = "font-mono";

function DecisionCell(p: ICellRendererParams<Attempt>) {
  return p.data ? <DecisionChip decision={p.data.decision} /> : null;
}
function StageCell(p: ICellRendererParams<Attempt>) {
  return p.data ? <StageChip stage={p.data.decision_stage} /> : null;
}
function SignalsCell(p: ICellRendererParams<Attempt>) {
  const sigs = p.data?.signals ?? [];
  if (sigs.length === 0) return <span className="text-mute/60">none</span>;
  // first-time payee is informational: show the alarming ones first
  const ordered = [...sigs].sort((a, b) => Number(a === "first_time_payee") - Number(b === "first_time_payee"));
  return (
    <div className="flex items-center gap-1.5 overflow-hidden">
      {ordered.slice(0, 3).map((s) => (
        <SignalChip key={s} id={s} />
      ))}
      {ordered.length > 3 && <span className="num text-xs text-mute">+{ordered.length - 3}</span>}
    </div>
  );
}
function AiCell(p: ICellRendererParams<Attempt>) {
  const ai = p.data?.ai;
  if (!ai) return <span className="text-mute/60">not run</span>;
  return (
    <div className="flex items-center gap-2.5">
      <RiskMeter risk={ai.risk} />
      {ai.error && <span className="text-[11px] font-semibold text-deny">fail-closed</span>}
    </div>
  );
}

function NoRows() {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center px-6 text-center">
      <div className="mb-4 grid size-14 place-items-center rounded-2xl border border-line-strong bg-raised text-accent-hi">
        <IconShield size={24} />
      </div>
      <h3 className="text-base font-semibold text-fg">The ledger is quiet</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-dim">Every tool call an agent makes appears here the moment it happens, with the reason Purser decided the way it did.</p>
      <Button tone="primary" size="sm" className="mt-5" onClick={() => navigate("lab")}>
        Run a scenario in the Attack Lab
      </Button>
    </div>
  );
}

interface Props {
  rows: Attempt[];
  fresh: Record<string, true>;
  decision: "all" | Decision;
  quick: string;
  onOpen: (id: string) => void;
}

export function AttemptsGrid({ rows, fresh, decision, quick, onOpen }: Props) {
  const api = useRef<GridApi<Attempt> | null>(null);
  const freshRef = useRef(fresh);
  const decisionRef = useRef(decision);
  const prevFresh = useRef<Record<string, true>>({});

  const cols = useMemo<ColDef<Attempt>[]>(
    () => [
      { headerName: "Time", field: "ts", width: 112, sort: "desc", sortIndex: 0, filter: false, valueFormatter: (p) => (p.value ? clock(p.value as string) : ""), cellClass: `${mono} text-dim`, comparator: (a: string, b: string) => Date.parse(a) - Date.parse(b) },
      { headerName: "Decision", field: "decision", width: 140, cellRenderer: DecisionCell, filter: "agTextColumnFilter" },
      { headerName: "Tool", field: "tool", width: 170, cellClass: `${mono} text-fg`, filter: "agTextColumnFilter" },
      { headerName: "Amount", width: 130, type: "rightAligned", valueGetter: (p) => p.data?.amount ?? null, valueFormatter: (p) => (p.value === null || p.value === undefined ? "n/a" : money(p.value as number, p.data?.currency)), cellClass: `${mono} font-semibold`, filter: "agNumberColumnFilter", filterValueGetter: (p) => (p.data?.amount ?? 0) / 100 },
      { headerName: "Payee", field: "payee_email", flex: 1.1, minWidth: 220, valueFormatter: (p) => (p.value as string | null) ?? "n/a", cellClass: `${mono} text-dim`, filter: "agTextColumnFilter" },
      { headerName: "Decided by", field: "decision_stage", width: 160, cellRenderer: StageCell, filter: "agTextColumnFilter", filterValueGetter: (p) => label(STAGE_LABEL, p.data?.decision_stage ?? "") },
      { headerName: "Signals", flex: 1.3, minWidth: 260, cellRenderer: SignalsCell, sortable: false, filter: "agTextColumnFilter", filterValueGetter: (p) => (p.data?.signals ?? []).join(" ") },
      { headerName: "AI risk", width: 150, cellRenderer: AiCell, valueGetter: (p) => p.data?.ai?.risk ?? -1, filter: "agNumberColumnFilter" },
      { headerName: "ms", field: "latency_ms", width: 86, type: "rightAligned", cellClass: `${mono} text-mute`, filter: "agNumberColumnFilter", valueFormatter: (p) => (p.value === null || p.value === undefined ? "" : String(p.value)) },
    ],
    [],
  );

  // keep refs current for the grid callbacks
  freshRef.current = fresh;
  decisionRef.current = decision;

  useEffect(() => {
    api.current?.onFilterChanged();
  }, [decision]);

  // when a row's highlight expires, redraw just that row so the class is dropped
  useEffect(() => {
    const g = api.current;
    if (g) {
      const gone = Object.keys(prevFresh.current).filter((id) => !fresh[id]);
      const nodes = gone.map((id) => g.getRowNode(id)).filter((n): n is NonNullable<typeof n> => Boolean(n));
      if (nodes.length) g.redrawRows({ rowNodes: nodes });
    }
    prevFresh.current = fresh;
  }, [fresh]);

  return (
    <div className="ag-theme-purser h-full w-full">
      <AgGridReact<Attempt>
        theme={purserTheme}
        rowData={rows}
        columnDefs={cols}
        defaultColDef={{ sortable: true, resizable: true, filter: true, suppressMovable: false }}
        getRowId={(p) => p.data.id}
        rowHeight={52}
        headerHeight={42}
        animateRows
        suppressCellFocus
        rowClassRules={{ "row-new": (p) => Boolean(p.data && freshRef.current[p.data.id]) }}
        quickFilterText={quick}
        isExternalFilterPresent={() => decisionRef.current !== "all"}
        doesExternalFilterPass={(node) => decisionRef.current === "all" || node.data?.decision === decisionRef.current}
        noRowsOverlayComponent={NoRows}
        onGridReady={(e: GridReadyEvent<Attempt>) => {
          api.current = e.api;
        }}
        onRowClicked={(e) => e.data && onOpen(e.data.id)}
      />
    </div>
  );
}
