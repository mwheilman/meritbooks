/**
 * Hover-peek card placement (audit 06 §L.3 L11: peeks rendered pinned
 * bottom-left over the sidebar). Table rows span the whole content width, so
 * the old "right of the row, else left of the row" rule never fit and fell back
 * to left=12px. Placement is now relative to the POINTER's x on the row and the
 * row's vertical band, always clamped inside the viewport.
 */
export interface PeekPlacementInput {
  /** Pointer x where the row was entered (viewport px). */
  anchorX: number;
  rowTop: number;
  rowBottom: number;
  viewportW: number;
  viewportH: number;
  cardW: number;
  cardH: number;
  /** Gap between anchor/row and the card. */
  gap?: number;
  /** Minimum distance from the viewport edge. */
  margin?: number;
}

export function placePeekCard(i: PeekPlacementInput): { left: number; top: number } {
  const gap = i.gap ?? 12;
  const margin = i.margin ?? 12;
  const maxLeft = Math.max(margin, i.viewportW - i.cardW - margin);
  const maxTop = Math.max(margin, i.viewportH - i.cardH - margin);

  // Horizontal: to the right of the pointer, else to its left, then clamp.
  let left = i.anchorX + gap;
  if (left + i.cardW + margin > i.viewportW) left = i.anchorX - gap - i.cardW;
  left = Math.min(Math.max(margin, left), maxLeft);

  // Vertical: below the row when it fits, else above it, else clamp.
  let top = i.rowBottom + 4;
  if (top + i.cardH + margin > i.viewportH) {
    const above = i.rowTop - 4 - i.cardH;
    top = above >= margin ? above : top;
  }
  top = Math.min(Math.max(margin, top), maxTop);

  return { left: Math.round(left), top: Math.round(top) };
}
