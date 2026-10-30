import { pointerWithin, type CollisionDetection } from "@dnd-kit/core";

/** Expanded folders overlap their ancestors; the pointer's deepest hit wins. */
export const fileTreeCollisionDetection: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  const depth = (id: string | number) =>
    id === "__root__" ? 0 : String(id).split("/").length;
  return hits.sort((a, b) => depth(b.id) - depth(a.id)).slice(0, 1);
};
