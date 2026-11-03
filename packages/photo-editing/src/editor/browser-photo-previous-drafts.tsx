"use client";

import { X } from "lucide-react";

import { PHOTO_EDITING_DURABLE_DRAFT_COPY } from "../photo-editing-copy";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "niho-ui/components/dialog";

import {
  PHOTO_EDITING_PRIMARY_BUTTON_CLASS_NAME,
  PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME,
} from "./photo-editing-button-classes";

export type BrowserPhotoPreviousDraftsModel = {
  busy: boolean;
  message: string | null;
  items: readonly { photoName: string; onOpen: () => void }[];
  selected: {
    photoName: string;
    actions: readonly { label: string; onClick: () => void }[];
  } | null;
  hasNext: boolean;
  isFirst: boolean;
  onNext: () => void;
  onFirst: () => void;
  onBack: () => void;
  onClose: () => void;
};

export function BrowserPhotoPreviousDraftsDialog(props: { model: BrowserPhotoPreviousDraftsModel | null }) {
  const model = props.model;
  const selected = model?.selected ?? null;
  return (
    <Dialog open={model !== null} onOpenChange={(open) => { if (!open && !model?.busy) model?.onClose(); }}>
      <DialogContent
        hideClose
        mobileSafeArea
        className="w-[calc(100vw-24px)] max-w-lg grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-2xl sm:max-h-[calc(100dvh-24px)]"
      >
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
          <DialogTitle className="text-body font-bold text-niho-text">
            {PHOTO_EDITING_DURABLE_DRAFT_COPY.previousTitle}
          </DialogTitle>
          <DialogDescription className="text-left text-sub leading-relaxed text-niho-text-sub">
            {PHOTO_EDITING_DURABLE_DRAFT_COPY.previousDescription}
          </DialogDescription>
        </DialogHeader>

        {selected ? (
          <div className="min-h-0 min-w-0 space-y-4 overflow-y-auto">
            <p className="break-words text-sm font-bold text-niho-text [overflow-wrap:anywhere]">{selected.photoName}</p>
            {model?.message ? <p role="status" className="text-sm leading-relaxed text-niho-text-sub">{model.message}</p> : null}
            <div className="flex flex-wrap gap-2">
              {selected.actions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  disabled={model?.busy}
                  onClick={action.onClick}
                  className={action.label === PHOTO_EDITING_DURABLE_DRAFT_COPY.previousSave
                    ? PHOTO_EDITING_PRIMARY_BUTTON_CLASS_NAME
                    : PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME}
                >
                  {action.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="min-h-0 min-w-0 space-y-3 overflow-y-auto">
            {model?.busy ? (
              <p role="status" className="text-sm text-niho-text-sub">{PHOTO_EDITING_DURABLE_DRAFT_COPY.previousChecking}</p>
            ) : model?.message ? (
              <p role="alert" className="text-sm leading-relaxed text-niho-text-sub">{model.message}</p>
            ) : model?.items.length ? (
              <ul className="space-y-2">
                {model.items.map((item, index) => (
                  <li key={`${index}:${item.photoName}`}>
                    <button
                      type="button"
                      disabled={model.busy}
                      onClick={item.onOpen}
                      className="flex min-h-11 w-full min-w-0 items-center justify-between gap-3 rounded-xl border border-niho-border px-3 py-2 text-left text-sm font-bold text-niho-text transition-colors hover:bg-niho-pale/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink disabled:opacity-50"
                    >
                      <span className="min-w-0 break-words [overflow-wrap:anywhere]">{item.photoName}</span>
                      <span className="shrink-0 text-xs text-niho-accent-ink">
                        {PHOTO_EDITING_DURABLE_DRAFT_COPY.previousOpen}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-niho-text-sub">{PHOTO_EDITING_DURABLE_DRAFT_COPY.previousEmpty}</p>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:space-x-0">
          {selected ? (
            <button type="button" disabled={model?.busy} onClick={model?.onBack} className={PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME}>
              {PHOTO_EDITING_DURABLE_DRAFT_COPY.previousBack}
            </button>
          ) : (
            <>
              {!model?.isFirst ? (
                <button type="button" disabled={model?.busy} onClick={model?.onFirst} className={PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME}>
                  {PHOTO_EDITING_DURABLE_DRAFT_COPY.previousFirst}
                </button>
              ) : null}
              {model?.hasNext ? (
                <button type="button" disabled={model.busy} onClick={model.onNext} className={PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME}>
                  {PHOTO_EDITING_DURABLE_DRAFT_COPY.previousNext}
                </button>
              ) : null}
            </>
          )}
          <button type="button" disabled={model?.busy} onClick={model?.onClose} className={PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME}>
            {PHOTO_EDITING_DURABLE_DRAFT_COPY.previousClose}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
