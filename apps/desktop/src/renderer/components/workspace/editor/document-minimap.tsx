import { useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent,
  PointerEvent,
  RefObject,
} from "react";
import { ListFilterIcon } from "lucide-react";
import { useSettingsStore } from "@/stores/settings-store";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import type {
  MinimapLayer,
  MinimapMarker,
  MinimapCluster,
} from "./editor-minimap-model";
import "./editor-minimap.css";

export interface MinimapGeometry {
  height: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  background?: string;
}

function lineLabel(marker: MinimapMarker) {
  return marker.line === marker.endLine
    ? `Line ${marker.line}`
    : `Lines ${marker.line}–${marker.endLine}`;
}

function reviewStackStyle(marker: MinimapMarker): CSSProperties | undefined {
  if (marker.kind !== "review" && marker.kind !== "conflict") return;
  const palette =
    marker.kind === "conflict"
      ? { ancestor: "#94a3b8", current: "#3b82f6", proposed: "#a855f7" }
      : { ancestor: "#94a3b8", current: "#ef4444", proposed: "#22c55e" };
  const colors = marker.reviewVersions?.length
    ? marker.reviewVersions.map((version) => palette[version])
    : ["#94a3b8"];
  const stops = colors.flatMap((color, index) => [
    ...(index ? [`transparent ${index * 4 - 1}px ${index * 4}px`] : []),
    `${color} ${index * 4}px ${index * 4 + 3}px`,
  ]);
  return {
    "--review-stack": `linear-gradient(to bottom, ${stops.join(", ")})`,
    "--review-height": `${colors.length * 4 - 1}px`,
  } as CSSProperties;
}

function MinimapMark({
  cluster,
  locationLabel = lineLabel,
  tabIndex,
  onFocus,
  onNavigate,
  onMoveFocus,
}: {
  cluster: MinimapCluster;
  locationLabel?: (marker: MinimapMarker) => string;
  tabIndex: number;
  onFocus: () => void;
  onNavigate: (markers: MinimapMarker[]) => void;
  onMoveFocus: (direction: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const dismissedByNavigation = useRef(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const index = Math.min(selectedIndex, cluster.markers.length - 1);
  const marker = cluster.markers[index];
  return (
    <HoverCard
      open={open}
      onOpenChange={(next) => {
        // Ignore a delayed hover/focus open after navigation moved the pointer.
        if (
          !next ||
          (!dismissedByNavigation.current &&
            (buttonRef.current?.matches(":hover") ||
              buttonRef.current === document.activeElement ||
              cardRef.current?.matches(":hover")))
        )
          setOpen(next);
      }}
      openDelay={180}
      closeDelay={120}
    >
      <HoverCardTrigger asChild>
        <button
          type="button"
          ref={buttonRef}
          className="editor-minimap-mark"
          data-minimap-marker={marker.kind}
          data-minimap-line={marker.line}
          data-minimap-lane={cluster.lane}
          aria-label={`${marker.title}, ${locationLabel(marker).toLowerCase()}${cluster.markers.length > 1 ? `, ${index + 1} of ${cluster.markers.length} nearby items` : ""}`}
          tabIndex={tabIndex}
          style={{ top: cluster.top, height: cluster.height }}
          onPointerEnter={() => {
            dismissedByNavigation.current = false;
          }}
          onPointerDown={(event) => {
            // Mouse focus would reopen the card after the outside-press dismissal.
            event.preventDefault();
            dismissedByNavigation.current = true;
            setOpen(false);
          }}
          onFocus={(event) => {
            event.preventDefault();
            dismissedByNavigation.current = false;
            onFocus();
            setOpen(true);
          }}
          onBlur={(event) => {
            event.preventDefault();
            setOpen(false);
          }}
          onClick={() => {
            dismissedByNavigation.current = true;
            setOpen(false);
            onNavigate(cluster.markers);
          }}
          onKeyDown={(event) => {
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              onMoveFocus(
                event.key === "Home"
                  ? -Infinity
                  : event.key === "End"
                    ? Infinity
                    : event.key === "ArrowDown"
                      ? 1
                      : -1,
              );
            } else if (
              event.key === "ArrowRight" ||
              event.key === "ArrowLeft"
            ) {
              event.preventDefault();
              setSelectedIndex(
                (index) =>
                  (index +
                    (event.key === "ArrowRight"
                      ? 1
                      : cluster.markers.length - 1)) %
                  cluster.markers.length,
              );
            } else if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
            }
          }}
        >
          <span className="editor-minimap-colors">
            {[
              ...new Map(
                cluster.markers.map((item) => [
                  `${item.kind}:${item.reviewVersions?.join(",") ?? ""}`,
                  item,
                ]),
              ).entries(),
            ].map(([key, item]) => (
              <span
                key={key}
                className="editor-minimap-stroke"
                data-kind={item.kind}
                data-review-versions={item.reviewVersions?.join(" ")}
                style={reviewStackStyle(item)}
              />
            ))}
          </span>
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        ref={cardRef}
        side="left"
        sideOffset={9}
        collisionPadding={12}
        className="editor-minimap-card"
      >
        {cluster.markers.length > 1 && (
          <div className="editor-minimap-card-heading">
            {cluster.markers.length} nearby items <span>← → to browse</span>
          </div>
        )}
        <div className="editor-minimap-card-items">
          {open &&
            cluster.markers.map((item, index) => (
              <button
                key={item.id}
                type="button"
                className="editor-minimap-card-item"
                data-active={index === selectedIndex}
                onClick={() => {
                  dismissedByNavigation.current = true;
                  setOpen(false);
                  onNavigate([item]);
                }}
              >
                <span className="editor-minimap-card-title">
                  <span
                    className="editor-minimap-dot"
                    data-kind={item.kind}
                    data-review-versions={item.reviewVersions?.join(" ")}
                    style={reviewStackStyle(item)}
                  />
                  {item.title}
                  <span>{locationLabel(item)}</span>
                </span>
                {item.before && (
                  <span className="editor-minimap-before">{item.before}</span>
                )}
                {item.detail && (
                  <span className="editor-minimap-detail">{item.detail}</span>
                )}
              </button>
            ))}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

export function DocumentMinimap({
  kind = "editor",
  trackRef,
  scrollElement,
  geometry,
  clusters,
  layerGroups,
  isReview = false,
  navigationLabel,
  locationLabel,
  onNavigate,
  onKeyDown,
  onScrollIntent,
}: {
  kind?: "editor" | "pdf";
  trackRef: RefObject<HTMLDivElement | null>;
  scrollElement: HTMLElement | null;
  geometry: MinimapGeometry;
  clusters: MinimapCluster[];
  layerGroups: { label: string; layers: MinimapLayer[] }[];
  isReview?: boolean;
  navigationLabel: string;
  locationLabel?: (marker: MinimapMarker) => string;
  onNavigate: (markers: MinimapMarker[]) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onScrollIntent?: () => void;
}) {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const layers = useSettingsStore((state) => state.editorMinimapLayers);
  const setLayer = useSettingsStore((state) => state.setEditorMinimapLayer);
  const isFiltered =
    !isReview &&
    layerGroups.some((group) => group.layers.some((layer) => !layers[layer]));
  const activeId = clusters.some((cluster) => cluster.id === focusedId)
    ? focusedId
    : clusters[0]?.id;
  const dragging = useRef<{
    pointerId: number;
    offset: number;
    top: number;
    travel: number;
    maxScroll: number;
    handleTop: number;
  } | null>(null);
  const viewportHeight = Math.min(
    geometry.height,
    Math.max(
      12,
      (geometry.clientHeight / Math.max(1, geometry.scrollHeight)) *
        geometry.height,
    ),
  );
  const viewportTop =
    dragging.current?.handleTop ??
    Math.min(
      geometry.height - viewportHeight,
      (Math.max(0, geometry.scrollTop) /
        Math.max(1, geometry.scrollHeight - geometry.clientHeight)) *
        (geometry.height - viewportHeight),
    );

  const scrollFromPointer = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragging.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const top = Math.max(
      0,
      Math.min(drag.travel, event.clientY - drag.top - drag.offset),
    );
    drag.handleTop = top;
    scrollElement?.scrollTo({
      top: drag.travel > 0 ? (top / drag.travel) * drag.maxScroll : 0,
      behavior: "instant",
    });
    // Keep the handle attached to the pointer while the document measures its viewport.
    if (viewportRef.current) viewportRef.current.style.top = `${top}px`;
  };
  return (
    <aside
      className="editor-minimap"
      onClick={kind === "pdf" ? (event) => event.stopPropagation() : undefined}
      aria-label={kind === "pdf" ? "PDF minimap" : "Document minimap"}
      data-editor-minimap={kind === "editor" ? "true" : undefined}
      data-pdf-minimap={kind === "pdf" ? "true" : undefined}
      style={{ "--minimap-background": geometry.background } as CSSProperties}
    >
      <DropdownMenu key={isReview ? "review" : "editing"}>
        <DropdownMenuTrigger asChild disabled={isReview}>
          <button
            type="button"
            className="editor-minimap-settings"
            aria-label="Minimap layers"
            data-filtered={isFiltered}
            disabled={isReview}
            title={
              isReview
                ? "Review markers are always shown"
                : isFiltered
                  ? "Minimap layers — filtering active"
                  : "Minimap layers"
            }
          >
            <ListFilterIcon aria-hidden="true" size={14} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="left" align="start" sideOffset={8}>
          <DropdownMenuLabel>Minimap layers</DropdownMenuLabel>
          {layerGroups.map((group) => (
            <DropdownMenuCheckboxItem
              key={group.label}
              checked={
                group.layers.every((layer) => layers[layer])
                  ? true
                  : group.layers.some((layer) => layers[layer])
                    ? "indeterminate"
                    : false
              }
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) => {
                for (const layer of group.layers) setLayer(layer, checked);
              }}
            >
              {group.label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <div
        ref={trackRef}
        className="editor-minimap-track"
        data-minimap-track="true"
      >
        <button
          type="button"
          className="editor-minimap-scrubber"
          aria-label={navigationLabel}
          onKeyDown={onKeyDown}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            onScrollIntent?.();
            const rect = trackRef.current?.getBoundingClientRect();
            if (!rect) return;
            const scroller = scrollElement;
            if (!scroller) return;
            const height = Math.min(
              rect.height,
              Math.max(
                12,
                (rect.height * scroller.clientHeight) /
                  Math.max(1, scroller.scrollHeight),
              ),
            );
            const travel = rect.height - height;
            const maxScroll = Math.max(
              0,
              scroller.scrollHeight - scroller.clientHeight,
            );
            const top =
              maxScroll > 0 ? (travel * scroller.scrollTop) / maxScroll : 0;
            const pointer = event.clientY - rect.top;
            const inside = pointer >= top && pointer <= top + height;
            dragging.current = {
              pointerId: event.pointerId,
              offset: inside ? pointer - top : height / 2,
              top: rect.top,
              travel,
              maxScroll,
              handleTop: top,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
            if (!inside) scrollFromPointer(event);
          }}
          onPointerMove={(event) => {
            scrollFromPointer(event);
          }}
          onPointerUp={(event) => {
            scrollFromPointer(event);
            dragging.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => {
            dragging.current = null;
          }}
          onLostPointerCapture={() => {
            dragging.current = null;
          }}
        />
        <span
          ref={viewportRef}
          className="editor-minimap-viewport"
          data-minimap-viewport="true"
          aria-hidden="true"
          style={{ top: viewportTop, height: viewportHeight }}
        />
        {clusters.map((cluster, index) => (
          <MinimapMark
            key={cluster.id}
            cluster={cluster}
            tabIndex={cluster.id === activeId ? 0 : -1}
            onFocus={() => setFocusedId(cluster.id)}
            onNavigate={onNavigate}
            locationLabel={locationLabel}
            onMoveFocus={(direction) => {
              const next =
                direction === -Infinity
                  ? 0
                  : direction === Infinity
                    ? clusters.length - 1
                    : (index + direction + clusters.length) % clusters.length;
              trackRef.current
                ?.querySelectorAll<HTMLButtonElement>("[data-minimap-marker]")
                [next]?.focus();
            }}
          />
        ))}
      </div>
    </aside>
  );
}
