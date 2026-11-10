import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as endpoints from '../../api/endpoints';
import { ManualEntry } from './ManualEntry';

vi.mock('../../api/endpoints', () => ({ geocodeAddress: vi.fn(async () => []) }));

afterEach(() => {
  cleanup();
});

function submit() {
  fireEvent.click(screen.getByRole('button', { name: 'Find this address' }));
}

describe('ManualEntry validation', () => {
  it('moves focus to the first invalid field, which names its error', () => {
    render(<ManualEntry onChoose={vi.fn()} onCancel={vi.fn()} />);
    submit();
    const street = screen.getByRole('textbox', { name: 'Street address' });
    expect(document.activeElement).toBe(street);
    expect(street.getAttribute('aria-invalid')).toBe('true');
    const described = document.getElementById(street.getAttribute('aria-describedby')!);
    expect(described?.textContent).toBe('Required');
    expect(vi.mocked(endpoints).geocodeAddress).not.toHaveBeenCalled();
  });

  it('follows the form order to a later invalid field, and again on every failed submit', () => {
    render(<ManualEntry onChoose={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Street address' }), {
      target: { value: '12 Lantern Hill Rd' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'City' }), {
      target: { value: 'Maplewood' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'State' }), { target: { value: 'VT' } });
    submit();
    const zip = screen.getByRole('textbox', { name: 'ZIP' });
    expect(document.activeElement).toBe(zip);

    screen.getByRole('button', { name: 'Find this address' }).focus();
    submit();
    expect(document.activeElement).toBe(zip);
  });
});
