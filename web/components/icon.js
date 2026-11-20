const paths = {
  overview: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  chat: "M21 11a8 8 0 0 1-8 8H8l-5 3V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3z M7 8h10 M7 12h7",
  folder: "M3 7V5a1 1 0 0 1 1-1h5l3 3h8a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z",
  book: "M4 4h14a2 2 0 0 1 2 2v14H6a2 2 0 0 1-2-2z M4 16h16 M8 8h8",
  workers: "M5 7h14v12H5z M9 11h.1 M15 11h.1 M9 15h6 M12 7V3 M2 11v4 M22 11v4",
  clock: "M12 2a10 10 0 1 0 .01 0 M12 6v6l4 2",
  hook: "M8 15l4-8a3 3 0 1 1 5 2 M12 7l5 8a3 3 0 1 1-2 4 M17 16H7a3 3 0 1 1-2-5",
  history: "M3 11a9 9 0 1 1 2 7 M3 5v6h6 M12 7v5l4 2",
  plane: "M21 3L3 10l7 3 3 7z M10 13L21 3",
  note: "M5 3h10l4 4v14H5z M14 3v5h5 M8 12h8 M8 16h6",
  logs: "M4 6h16 M4 12h16 M4 18h11",
  terminal: "M4 5h16v14H4z M7 9l3 3-3 3 M12 15h5",
};
export function icon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [key, value] of Object.entries({
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.6",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    class: "icon",
  }))
    svg.setAttribute(key, value);
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", paths[name]);
  svg.append(path);
  return svg;
}
