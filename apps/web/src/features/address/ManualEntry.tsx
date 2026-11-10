import { useEffect, useId, useState, type FormEvent } from 'react';
import { GeocodeRequestSchema, type GeocodeCandidate } from '@holiday/core';
import { geocodeAddress } from '../../api/endpoints';
import { presentError } from '../../api/present';
import { t } from '../../copy';
import { Icon } from '../../ui/Icon';

/** US states, the District of Columbia, by postal abbreviation (data, not copy). */
const US_STATES = [
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'DC',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
] as const;

interface Fields {
  line1: string;
  line2: string;
  city: string;
  state: string;
  postalCode: string;
}

type FieldErrors = Partial<Record<keyof Fields, string>>;

/** The fields in the order they appear in the form. */
const FIELD_ORDER: ReadonlyArray<keyof Fields> = ['line1', 'line2', 'city', 'state', 'postalCode'];

function validate(fields: Fields): FieldErrors {
  const errors: FieldErrors = {};
  if (!fields.line1.trim()) errors.line1 = t('address.fieldRequired');
  if (!fields.city.trim()) errors.city = t('address.fieldRequired');
  if (!fields.state) errors.state = t('address.stateInvalid');
  if (!/^\d{5}(-\d{4})?$/.test(fields.postalCode.trim()))
    errors.postalCode = t('address.zipInvalid');
  return errors;
}

export interface ManualEntryProps {
  /** Called with the chosen candidate; the caller resolves it. */
  onChoose: (candidate: GeocodeCandidate) => void;
  onCancel: () => void;
  busy?: boolean;
}

/**
 * Structured US address entry. Submitting geocodes the address and lists candidates
 * ("Which of these did you mean?"); a chosen candidate is resolved by the caller and always
 * goes to the confirm screen.
 */
export function ManualEntry({ onChoose, onCancel, busy }: ManualEntryProps) {
  const id = useId();
  const [fields, setFields] = useState<Fields>({
    line1: '',
    line2: '',
    city: '',
    state: '',
    postalCode: '',
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [candidates, setCandidates] = useState<GeocodeCandidate[] | null>(null);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  /** Set by a submit that failed validation: the first invalid field, focused once rendered. */
  const [focusTarget, setFocusTarget] = useState<{ key: keyof Fields } | null>(null);

  useEffect(() => {
    if (focusTarget) document.getElementById(`${id}-${focusTarget.key}`)?.focus();
  }, [focusTarget, id]);

  const update = (key: keyof Fields) => (value: string) => {
    setFields((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  };

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const found = validate(fields);
    setErrors(found);
    setFormError(null);
    const firstInvalid = FIELD_ORDER.find((key) => found[key]);
    if (firstInvalid) {
      // A fresh object each time, so a repeated failed submit moves focus again.
      setFocusTarget({ key: firstInvalid });
      return;
    }
    const body = GeocodeRequestSchema.safeParse({
      line1: fields.line1,
      ...(fields.line2.trim() ? { line2: fields.line2 } : {}),
      city: fields.city,
      state: fields.state,
      postalCode: fields.postalCode,
    });
    if (!body.success) {
      setFormError(t('error.VALIDATION_FAILED'));
      return;
    }
    setPending(true);
    try {
      const result = await geocodeAddress(body.data);
      if (result.length === 0) setFormError(t('error.ADDRESS_NOT_FOUND'));
      setCandidates(result);
    } catch (error) {
      setCandidates(null);
      setFormError(presentError(error)?.message ?? null);
    } finally {
      setPending(false);
    }
  }

  const field = (
    key: keyof Fields,
    labelKey: Parameters<typeof t>[0],
    options: { autoComplete: string; inputMode?: 'numeric' },
  ) => {
    const fieldId = `${id}-${key}`;
    const errorId = `${fieldId}-error`;
    return (
      <div className={`field manual__${key}`}>
        <label className="field__label" htmlFor={fieldId}>
          {t(labelKey)}
        </label>
        <input
          id={fieldId}
          className="input"
          value={fields[key]}
          autoComplete={options.autoComplete}
          inputMode={options.inputMode}
          aria-invalid={errors[key] ? true : undefined}
          aria-describedby={errors[key] ? errorId : undefined}
          onChange={(event) => update(key)(event.target.value)}
        />
        {errors[key] ? (
          <span id={errorId} className="field__error">
            {errors[key]}
          </span>
        ) : null}
      </div>
    );
  };

  return (
    <div className="manual stack">
      <form
        className="manual__form"
        onSubmit={onSubmit}
        noValidate
        aria-labelledby={`${id}-heading`}
      >
        <h2 id={`${id}-heading`} className="manual__heading">
          {t('address.manualHeading')}
        </h2>
        {field('line1', 'address.fields.street', { autoComplete: 'address-line1' })}
        {field('line2', 'address.fields.unit', { autoComplete: 'address-line2' })}
        <div className="manual__row">
          {field('city', 'address.fields.city', { autoComplete: 'address-level2' })}
          <div className="field manual__state">
            <label className="field__label" htmlFor={`${id}-state`}>
              {t('address.fields.state')}
            </label>
            <select
              id={`${id}-state`}
              className="input"
              value={fields.state}
              autoComplete="address-level1"
              aria-invalid={errors.state ? true : undefined}
              aria-describedby={errors.state ? `${id}-state-error` : undefined}
              onChange={(event) => update('state')(event.target.value)}
            >
              <option value="">{t('address.statePlaceholder')}</option>
              {US_STATES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
            {errors.state ? (
              <span id={`${id}-state-error`} className="field__error">
                {errors.state}
              </span>
            ) : null}
          </div>
          {field('postalCode', 'address.fields.zip', {
            autoComplete: 'postal-code',
            inputMode: 'numeric',
          })}
        </div>
        {formError ? (
          <p className="message message--error" role="alert">
            {formError}
          </p>
        ) : null}
        <div className="row">
          <button
            type="submit"
            className="button button--primary"
            aria-disabled={pending || undefined}
          >
            {t('address.manualSubmit')}
          </button>
          <button type="button" className="button button--quiet" onClick={onCancel}>
            {t('address.searchInstead')}
          </button>
        </div>
      </form>

      {candidates && candidates.length > 0 ? (
        <section className="manual__candidates" aria-labelledby={`${id}-candidates`}>
          <h3 id={`${id}-candidates`} className="manual__candidates-heading">
            {t('address.manualCandidates')}
          </h3>
          <ul className="candidate-list">
            {candidates.map((candidate) => (
              <li key={candidate.candidateId}>
                <button
                  type="button"
                  className="candidate-list__item"
                  aria-disabled={busy || undefined}
                  onClick={() => {
                    if (!busy) onChoose(candidate);
                  }}
                >
                  <Icon name="pin" />
                  <span className="candidate-list__text">
                    <span>{candidate.formattedAddress}</span>
                    {candidate.partialMatch ? (
                      <span className="candidate-list__meta">{t('address.partialMatch')}</span>
                    ) : null}
                  </span>
                  <Icon name="chevronRight" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
