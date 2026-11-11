import { AgGridReact } from "ag-grid-react";
import type { ColDef, GridApi, GridReadyEvent, ICellRendererParams } from "ag-grid-community";
import { useEffect, useMemo, useRef } from "react";
import { purserTheme } from "../lib/gridTheme";
import { clock } from "../lib/format";
import type { ReconFinding } from "../lib/types";
import { IconScale } from "./icons";
import { TypeChip, kindOf, KIND_LABEL, type RowKind } from "./ReconChips";

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const why = (f: ReconFinding): string => str(f.detail.message) || str(f.detail.note) || (f.matched ? "Matches what Purser approved." : str(f.detail.reason));

function TypeCell(p: ICellRendererParams<ReconFinding>) {
  return p.data ? <TypeChip kind={kindOf(p.data)} /> : null;
}

function NoRows() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-6 text-center">
      <div className="float mb-4 grid size-14 place-items-center rounded-full bg-lime text-accent-hi">
        <IconScale size={24} />
      </div>
      <h3 className="text-xl text-fg">No findings yet</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-dim">Press Run now to compare PayPal with Purser&apos;s ledger, or wait for a webhook. Money that moved without Purser appears here the moment it is seen.</p>
    </div>
  );
}

interface Props {
  rows: ReconFinding[];
  fresh: Record<string, true>;
  kind: "all" | RowKind;
  onOpen: (f: ReconFinding) => void;
}

export function ReconGrid({ rows, fresh, kind, onOpen }: Props) {
  const api = useRef<GridApi<ReconFinding> | null>(null);
  const freshRef = useRef(fresh);
  const kindRef = useRef(kind);
  const prevFresh = useRef<Record<string, true>>({});
  freshRef.current = fresh;
  kindRef.current = kind;

  const cols = useMemo<ColDef<ReconFinding>[]>(
    () => [
      { headerName: "Time", field: "ts", width: 104, sort: "desc", valueFormatter: (p) => (p.value ? clock(p.value as string) : ""), cellClass: "font-mono text-dim", comparator: (a: string, b: string) => Date.parse(a) - Date.parse(b), filter: false },
      { headerName: "Finding", width: 210, cellRenderer: TypeCell, valueGetter: (p) => (p.data ? KIND_LABEL[kindOf(p.data)] : ""), filter: "agTextColumnFilter" },
      { headerName: "Amount", width: 120, type: "rightAligned", valueGetter: (p) => str(p.data?.detail.amount) || "n/a", cellClass: "font-mono font-medium", filter: "agTextColumnFilter" },
      { headerName: "Receiver", flex: 1, minWidth: 200, valueGetter: (p) => str(p.data?.detail.receiver) || "n/a", cellClass: "font-mono text-dim", filter: "agTextColumnFilter" },
      { headerName: "Why", flex: 2, minWidth: 280, valueGetter: (p) => (p.data ? why(p.data) : ""), tooltipValueGetter: (p) => (p.data ? why(p.data) : ""), cellClass: "text-dim", filter: "agTextColumnFilter" },
      { headerName: "Event", field: "event_type", width: 250, valueFormatter: (p) => (p.value as string | null) ?? "n/a", cellClass: "font-mono text-mute text-[12px]", filter: "agTextColumnFilter" },
      { headerName: "Source", width: 110, valueGetter: (p) => (p.data?.detail.simulated ? "simulated" : p.data?.event_type === "RECONCILIATION_RUN" || p.data?.event_type === "TRANSACTION_SEARCH" ? "run" : "webhook"), cellClass: "text-mute", filter: "agTextColumnFilter" },
    ],
    [],
  );

  useEffect(() => {
    api.current?.onFilterChanged();
  }, [kind]);

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
      <AgGridReact<ReconFinding>
        theme={purserTheme}
        rowData={rows}
        columnDefs={cols}
        defaultColDef={{ sortable: true, resizable: true, filter: true }}
        getRowId={(p) => p.data.id}
        rowHeight={52}
        headerHeight={42}
        animateRows
        tooltipShowDelay={400}
        rowClassRules={{ "row-new": (p) => Boolean(p.data && freshRef.current[p.data.id]) }}
        isExternalFilterPresent={() => kindRef.current !== "all"}
        doesExternalFilterPass={(node) => kindRef.current === "all" || (node.data ? kindOf(node.data) === kindRef.current : true)}
        noRowsOverlayComponent={NoRows}
        onGridReady={(e: GridReadyEvent<ReconFinding>) => {
          api.current = e.api;
        }}
        onRowClicked={(e) => e.data && onOpen(e.data)}
        onCellKeyDown={(e) => {
          const k = (e.event as KeyboardEvent | null)?.key;
          if (k === "Enter" && e.data) onOpen(e.data);
        }}
      />
    </div>
  );
}
