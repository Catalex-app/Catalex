import { Component, createRef, type ReactNode } from "react";

type Props = { provider: string; children: ReactNode };
type Snapshot = {
  height: number;
  usageHeight: number;
} | null;

export class ModelPickerTransition extends Component<Props> {
  private contentRef = createRef<HTMLDivElement>();
  private animations: Animation[] = [];

  private clear = () => {
    for (const animation of this.animations) animation.cancel();
    this.animations = [];
  };

  getSnapshotBeforeUpdate(): Snapshot {
    const content = this.contentRef.current;
    const popup = content?.parentElement;
    const usage = content?.querySelector<HTMLElement>(
      "[data-subscription-usage]",
    );
    if (!content || !popup || !usage) return null;
    return {
      height: popup.getBoundingClientRect().height,
      usageHeight: usage.getBoundingClientRect().height,
    };
  }

  componentDidUpdate(previous: Props, _state: unknown, snapshot: Snapshot) {
    if (!snapshot) return;
    this.clear();
    const content = this.contentRef.current;
    const popup = content?.parentElement;
    if (
      !content ||
      !popup ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const targetHeight = popup.getBoundingClientRect().height;
    const usage = content.querySelector<HTMLElement>(
      "[data-subscription-usage]",
    );
    const body = content.querySelector<HTMLElement>(
      "[data-subscription-content]",
    );
    const usageHeight = usage?.getBoundingClientRect().height;
    const options = { duration: 220, easing: "cubic-bezier(0.22, 1, 0.36, 1)" };
    if (Math.abs(snapshot.height - targetHeight) > 0.5) {
      this.animations.push(
        popup.animate(
          [{ height: `${snapshot.height}px` }, { height: `${targetHeight}px` }],
          options,
        ),
      );
    }
    if (
      usage &&
      usageHeight !== undefined &&
      Math.abs(snapshot.usageHeight - usageHeight) > 0.5
    ) {
      this.animations.push(
        usage.animate(
          [
            { height: `${snapshot.usageHeight}px` },
            { height: `${usageHeight}px` },
          ],
          options,
        ),
      );
    }
    if (body && previous.provider !== this.props.provider) {
      this.animations.push(
        body.animate([{ opacity: 0 }, { opacity: 1 }], options),
      );
    }
  }

  componentWillUnmount() {
    this.clear();
  }

  render() {
    return (
      <div
        ref={this.contentRef}
        data-model-picker-content=""
        className="flex min-h-0 flex-col"
      >
        {this.props.children}
      </div>
    );
  }
}
