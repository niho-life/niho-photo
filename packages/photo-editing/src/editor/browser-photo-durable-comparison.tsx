"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";

import type { DevelopFrame } from "../develop-engine/develop-engine-client";
import { paintDevelopFrame } from "../develop-engine/develop-frame";
import { PHOTO_EDITING_DURABLE_DRAFT_COPY } from "../photo-editing-copy";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "niho-ui/components/dialog";

import {
  PHOTO_EDITING_PRIMARY_BUTTON_CLASS_NAME,
  PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME,
} from "./photo-editing-button-classes";

export type BrowserPhotoDurableComparisonModel = {
  photoName: string;
  loading: boolean;
  candidateFrame: DevelopFrame | null;
  currentFrame: DevelopFrame | null;
  candidateReason: string | null;
  currentReason: string | null;
  canAdopt: boolean;
  busy: boolean;
  onAdopt: () => void;
  onKeepCurrent: () => void;
  onSaveData: (() => void) | null;
  onClose: () => void;
};

function ComparisonPreview(props: { label: string; frame: DevelopFrame | null; reason: string | null; loading: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !props.frame) return;
    paintDevelopFrame(canvas, props.frame);
    return () => {
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [props.frame]);
  return (
    <section className="min-w-0 space-y-2" aria-label={props.label}>
      <h3 className="text-sm font-bold text-niho-text">{props.label}</h3>
      <div className="flex min-h-40 items-center justify-center overflow-hidden rounded-xl border border-niho-border bg-niho-pale/30 p-2 sm:min-h-56">
        {props.frame ? (
          <canvas ref={canvasRef} role="img" aria-label={`${props.label}のプレビュー`} className="max-h-[min(42vh,512px)] max-w-full object-contain" />
        ) : (
          <p role={props.reason ? "status" : undefined} className="max-w-xs text-center text-sm leading-relaxed text-niho-text-sub">
            {props.loading ? PHOTO_EDITING_DURABLE_DRAFT_COPY.checking : props.reason}
          </p>
        )}
      </div>
    </section>
  );
}

export function BrowserPhotoDurableComparisonDialog(props: { model: BrowserPhotoDurableComparisonModel | null }) {
  const model = props.model;
  return (
    <Dialog open={model !== null} onOpenChange={(open) => { if (!open && !model?.busy) model?.onClose(); }}>
      <DialogContent hideClose mobileSafeArea className="w-[calc(100vw-24px)] max-w-4xl overflow-y-auto rounded-2xl sm:max-h-[calc(100dvh-24px)]">
        <button
          type="button"
          aria-label={PHOTO_EDITING_DURABLE_DRAFT_COPY.close}
          disabled={model?.busy}
          onClick={model?.onClose}
          className="absolute right-4 top-4 flex h-6 w-6 items-center justify-center rounded-sm text-niho-text-sub hover:text-niho-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
        <DialogHeader className="min-w-0 pr-6">
          <DialogTitle className="text-body font-bold text-niho-text">{PHOTO_EDITING_DURABLE_DRAFT_COPY.comparisonTitle}</DialogTitle>
          <DialogDescription className="space-y-1 text-left text-sub text-niho-text-sub">
            <span className="block break-words font-bold text-niho-text [overflow-wrap:anywhere]">{model?.photoName}</span>
            <span className="block">{PHOTO_EDITING_DURABLE_DRAFT_COPY.comparisonDescription}</span>
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <ComparisonPreview
            label={PHOTO_EDITING_DURABLE_DRAFT_COPY.devicePreview}
            frame={model?.candidateFrame ?? null}
            reason={model?.candidateReason ?? null}
            loading={model?.loading === true}
          />
          <ComparisonPreview
            label={PHOTO_EDITING_DURABLE_DRAFT_COPY.currentPreview}
            frame={model?.currentFrame ?? null}
            reason={model?.currentReason ?? null}
            loading={model?.loading === true}
          />
        </div>
        <p className="text-xs leading-relaxed text-niho-text-muted">{PHOTO_EDITING_DURABLE_DRAFT_COPY.historicalNotice}</p>
        <DialogFooter className="gap-2 sm:space-x-0">
          {model?.onSaveData ? (
            <button type="button" disabled={model.busy} onClick={model.onSaveData} className={PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME}>
              {PHOTO_EDITING_DURABLE_DRAFT_COPY.saveData}
            </button>
          ) : null}
          <button type="button" disabled={model?.busy} onClick={model?.onClose} className={PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME}>
            {PHOTO_EDITING_DURABLE_DRAFT_COPY.back}
          </button>
          <button type="button" disabled={model?.busy} onClick={model?.onKeepCurrent} className={PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME}>
            {PHOTO_EDITING_DURABLE_DRAFT_COPY.useCurrent}
          </button>
          {model?.canAdopt ? (
            <button type="button" disabled={model.busy} onClick={model.onAdopt} className={PHOTO_EDITING_PRIMARY_BUTTON_CLASS_NAME}>
              {PHOTO_EDITING_DURABLE_DRAFT_COPY.useDevice}
            </button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
