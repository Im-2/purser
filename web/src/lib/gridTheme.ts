import { AllCommunityModule, ModuleRegistry, themeQuartz } from "ag-grid-community";

ModuleRegistry.registerModules([AllCommunityModule]);

/** AG Grid Theming API: Quartz (light), white rows, hairline borders, colours read from the token file via CSS variables. */
export const purserTheme = themeQuartz.withParams({
  backgroundColor: "var(--color-panel)",
  foregroundColor: "var(--color-fg)",
  borderColor: "var(--color-line)",
  headerBackgroundColor: "var(--color-panel)",
  headerTextColor: "var(--color-mute)",
  headerFontWeight: 500,
  oddRowBackgroundColor: "var(--color-panel)",
  rowHoverColor: "var(--color-hover)",
  selectedRowBackgroundColor: "var(--color-lime)",
  accentColor: "var(--color-ink)",
  fontFamily: "Inter Tight Variable, ui-sans-serif, system-ui, sans-serif",
  fontSize: 14,
  headerFontSize: 11,
  rowBorder: { color: "var(--color-line)", width: 1 },
  headerRowBorder: { color: "var(--color-line)", width: 1 },
  columnBorder: false,
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  spacing: 7,
  inputBackgroundColor: "var(--color-sunken)",
  menuBackgroundColor: "var(--color-panel)",
  borderRadius: 12,
});
