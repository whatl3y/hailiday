import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../state/appStore';
import { useIsFixtureAddressLookup } from './fixture';

afterEach(() => {
  cleanup();
  useAppStore.setState({ fixtureCapabilities: [] });
});

describe('useIsFixtureAddressLookup', () => {
  it('follows the address_lookup entry of the fixture capability list', () => {
    useAppStore.setState({ fixtureCapabilities: ['street_view_display', 'image_editing'] });
    const { result } = renderHook(() => useIsFixtureAddressLookup());
    expect(result.current).toBe(false);

    act(() => {
      useAppStore.setState({ fixtureCapabilities: ['address_lookup', 'street_view_display'] });
    });
    expect(result.current).toBe(true);
  });
});
