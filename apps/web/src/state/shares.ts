import { create } from 'zustand';
import type { CreateShareResponse } from '@holiday/core';
import { readStored, writeStored } from './persist';

const STORAGE_KEY = 'holiday.shares';

/** A share link this device created, so the share sheet can show it and stop sharing. */
export interface ShareRecord extends CreateShareResponse {
  renderAssetId: string;
  projectId: string;
  includeBefore: boolean;
}

function readShares(): Record<string, ShareRecord> {
  const raw = readStored('local', STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, ShareRecord>;
    const now = Date.now();
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([, record]) =>
          typeof record?.token === 'string' &&
          typeof record.url === 'string' &&
          Date.parse(record.expiresAt) > now,
      ),
    );
  } catch {
    return {};
  }
}

interface SharesState {
  byVariant: Record<string, ShareRecord>;
  remember(record: ShareRecord): void;
  forget(renderAssetId: string): void;
  forgetProject(projectId: string): void;
  clear(): void;
}

function persist(byVariant: Record<string, ShareRecord>): void {
  writeStored(
    'local',
    STORAGE_KEY,
    Object.keys(byVariant).length > 0 ? JSON.stringify(byVariant) : null,
  );
}

/** Share links created on this device, keyed by the variant they share. */
export const useShareStore = create<SharesState>()((set, get) => ({
  byVariant: readShares(),
  remember(record) {
    const byVariant = { ...get().byVariant, [record.renderAssetId]: record };
    persist(byVariant);
    set({ byVariant });
  },
  forget(renderAssetId) {
    const { [renderAssetId]: _removed, ...byVariant } = get().byVariant;
    persist(byVariant);
    set({ byVariant });
  },
  forgetProject(projectId) {
    const byVariant = Object.fromEntries(
      Object.entries(get().byVariant).filter(([, record]) => record.projectId !== projectId),
    );
    persist(byVariant);
    set({ byVariant });
  },
  clear() {
    persist({});
    set({ byVariant: {} });
  },
}));
