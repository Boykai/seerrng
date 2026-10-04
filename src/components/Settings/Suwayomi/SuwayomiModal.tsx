import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Modal from '@app/components/Common/Modal';
import SelectionCircle from '@app/components/Common/SelectionCircle';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import Field, {
  default as SettingsField,
} from '@app/components/Settings/SettingsField';
import {
  authModeMessages,
  messages,
  sharedMessages,
  warningMessages,
} from '@app/components/Settings/Suwayomi/messages';
import {
  authModeBadgeType,
  buildSaveRequest,
  buildTestRequest,
  clearsStoredPassword,
  describeSuwayomiError,
  filterSourceEntries,
  hasLineBreak,
  isSettingsAuthMode,
  isValidHostname,
  isValidLanguageList,
  isValidPort,
  isValidScanlatorList,
  isValidUrlBase,
  orderSourceEntries,
  readSuwayomiError,
  readTestDiagnostics,
  readTestFailure,
  readTestSources,
  resetsValidation,
  showsSourceLanguage,
  SUWAYOMI_MAX_LANGUAGES,
  SUWAYOMI_MAX_PASSWORD_LENGTH,
  SUWAYOMI_MAX_SCANLATOR_LENGTH,
  SUWAYOMI_MAX_SCANLATORS,
  SUWAYOMI_MAX_SOURCES,
  SUWAYOMI_MAX_TEXT_LENGTH,
  suwayomiFormValues,
  toggleSourceId,
  type SuwayomiErrorBody,
  type SuwayomiFormValues,
  type SuwayomiSourceEntry,
  type SuwayomiTestDiagnostics,
} from '@app/components/Settings/Suwayomi/suwayomiForm';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import { isRedactedSecret } from '@app/utils/secret';
import { Transition } from '@headlessui/react';
import type {
  SuwayomiConnectionTestSource,
  SuwayomiConnectionTestWarning,
  SuwayomiSettingsView,
} from '@server/interfaces/api/suwayomiInterfaces';
import type { SuwayomiSettingsAuthMode } from '@server/lib/settings';
import axios from 'axios';
import { Formik, useField } from 'formik';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import * as Yup from 'yup';

interface TestOutcome extends SuwayomiTestDiagnostics {
  /** Set when the test failed. */
  error?: SuwayomiErrorBody;
  /** Set when the test succeeded. */
  sources?: SuwayomiConnectionTestSource[];
}

const FieldError = ({ name }: { name: keyof SuwayomiFormValues }) => {
  const [, meta] = useField(name);
  return meta.touched && typeof meta.error === 'string' ? (
    <div className="error">{meta.error}</div>
  ) : null;
};

const TestResultPanel = ({ result }: { result: TestOutcome }) => {
  const intl = useIntl();
  const sourceNames = new Map(
    (result.sources ?? []).map(({ id, displayName }) => [id, displayName])
  );
  const describeWarning = ({
    code,
    count,
    sourceIds,
  }: SuwayomiConnectionTestWarning) =>
    intl.formatMessage(warningMessages[code], {
      count: count ?? 0,
      sources: (sourceIds ?? [])
        .map((id) => sourceNames.get(id) ?? id)
        .join(', '),
    });
  const authDisabled = result.warnings.some(
    ({ code }) => code === 'AUTH_DISABLED'
  );
  const warnings = result.warnings.filter(
    ({ code }) => code !== 'AUTH_DISABLED'
  );

  return (
    <>
      {(result.error || authDisabled || warnings.length > 0) && (
        <div className="form-row">
          <div className="col-span-full">
            {result.error && (
              <Alert
                type="error"
                title={describeSuwayomiError(
                  intl,
                  result.error,
                  messages.testFailure
                )}
              />
            )}
            {authDisabled && (
              <Alert type="error" title={intl.formatMessage(messages.authNone)}>
                {intl.formatMessage(messages.warnAuthDisabled)}
              </Alert>
            )}
            {warnings.length > 0 && (
              <Alert type="warning">
                <ul className="list-disc pl-5">
                  {warnings.map((warning, index) => (
                    <li key={`${warning.code}-${index}`}>
                      {describeWarning(warning)}
                    </li>
                  ))}
                </ul>
              </Alert>
            )}
          </div>
        </div>
      )}
      {result.authMode && (
        <div className="form-row">
          <span className="group-label">
            {intl.formatMessage(messages.authentication)}
          </span>
          <div className="form-input-area">
            <Badge badgeType={authModeBadgeType[result.authMode]}>
              {intl.formatMessage(authModeMessages[result.authMode])}
            </Badge>
          </div>
        </div>
      )}
      {result.version && (
        <div className="form-row">
          <span className="group-label">
            {intl.formatMessage(messages.version)}
          </span>
          <div className="form-input-area">{result.version}</div>
        </div>
      )}
    </>
  );
};

const SourceBadges = ({
  entry,
  tested,
}: {
  entry: SuwayomiSourceEntry;
  tested: boolean;
}) => {
  const intl = useIntl();
  const { source, priority } = entry;

  return (
    <>
      {priority && (
        <Badge>{intl.formatMessage(messages.priority, { priority })}</Badge>
      )}
      {tested && !source && (
        <Badge badgeType="danger">{intl.formatMessage(messages.missing)}</Badge>
      )}
      {source?.isObsolete && (
        <Badge badgeType="danger">
          {intl.formatMessage(messages.obsolete)}
        </Badge>
      )}
      {source?.hasUpdate && (
        <Badge badgeType="warning">
          {intl.formatMessage(messages.updateAvailable)}
        </Badge>
      )}
      {source?.contentWarning === 'NSFW' && (
        <Badge badgeType="danger">{intl.formatMessage(messages.nsfw)}</Badge>
      )}
      {source?.contentWarning === 'MIXED' && (
        <Badge badgeType="warning">{intl.formatMessage(messages.mixed)}</Badge>
      )}
      {source?.contentWarning === 'SAFE' && (
        <Badge badgeType="success">{intl.formatMessage(messages.safe)}</Badge>
      )}
      {source && showsSourceLanguage(source) && (
        <Badge badgeType="light">{source.lang.toUpperCase()}</Badge>
      )}
    </>
  );
};

const SourcePicker = ({
  sources,
  selected,
  onChange,
}: {
  /** Undefined until a test succeeds. */
  sources?: SuwayomiConnectionTestSource[];
  selected: string[];
  onChange: (selected: string[]) => void;
}) => {
  const intl = useIntl();
  const [query, setQuery] = useState('');
  // The filter box exists only while sources are loaded; a hidden query must
  // not hide the stored sources.
  const activeQuery = sources ? query : '';
  const entries = useMemo(
    () =>
      filterSourceEntries(orderSourceEntries(sources, selected), activeQuery),
    [sources, selected, activeQuery]
  );
  const atLimit = selected.length >= SUWAYOMI_MAX_SOURCES;

  return (
    <div className="form-row">
      <span className="group-label">
        {intl.formatMessage(messages.sources)}
      </span>
      <div className="form-input-area">
        {sources && (
          <div className="form-input-field">
            <input
              id="sourceFilter"
              type="text"
              value={query}
              placeholder={intl.formatMessage(messages.filterSources)}
              aria-label={intl.formatMessage(messages.filterSources)}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        )}
      </div>
      <span className="settings-form-row-description">
        {intl.formatMessage(messages.sourcesTip)}
        {!sources && ` ${intl.formatMessage(messages.runTest)}`}
        {atLimit &&
          ` ${intl.formatMessage(messages.sourceLimit, {
            max: SUWAYOMI_MAX_SOURCES,
          })}`}
      </span>
      {entries.length > 0 ? (
        <ul className="settings-library-grid col-span-full lg:grid-cols-2">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="app-card-sub settings-library-card col-span-1 flex shadow-sm"
            >
              <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
                <div className="settings-library-card-content">
                  <span className="truncate">
                    {entry.source?.displayName ?? entry.id}
                  </span>
                  <SourceBadges entry={entry} tested={!!sources} />
                </div>
                <div className="flex-shrink-0">
                  <SelectionCircle
                    selected={!!entry.priority}
                    disabled={!entry.priority && atLimit}
                    label={entry.source?.displayName ?? entry.id}
                    onClick={() => onChange(toggleSourceId(selected, entry.id))}
                  />
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        activeQuery && (
          <span className="settings-form-row-description">
            {intl.formatMessage(globalMessages.noresults)}
          </span>
        )
      )}
    </div>
  );
};

interface SuwayomiModalProps {
  suwayomi: SuwayomiSettingsView | null;
  onClose: () => void;
  onSave: () => void;
}

const SuwayomiModal = ({ suwayomi, onClose, onSave }: SuwayomiModalProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  // Editing starts from the stored, already tested settings.
  const [isValidated, setIsValidated] = useState(!!suwayomi);
  const [isTesting, setIsTesting] = useState(false);
  // Save sends the stored mode until a test in this session detects one.
  const [authMode, setAuthMode] = useState<
    SuwayomiSettingsAuthMode | undefined
  >(suwayomi?.authMode);
  const [result, setResult] = useState<TestOutcome | null>(null);
  const testRequest = useRef<AbortController | null>(null);

  const abortTest = () => {
    testRequest.current?.abort();
    testRequest.current = null;
  };

  useEffect(() => () => testRequest.current?.abort(), []);

  const testConnection = async (values: SuwayomiFormValues) => {
    const controller = new AbortController();
    testRequest.current = controller;
    setIsTesting(true);
    try {
      const { data } = await axios.post<unknown>(
        '/api/v1/settings/suwayomi/test',
        buildTestRequest(values, suwayomi?.id),
        { signal: controller.signal }
      );
      if (controller.signal.aborted) return;
      const diagnostics = readTestDiagnostics(data);
      setAuthMode(
        isSettingsAuthMode(diagnostics.authMode)
          ? diagnostics.authMode
          : undefined
      );
      setResult({ ...diagnostics, sources: readTestSources(data) });
      setIsValidated(true);
      addToast(intl.formatMessage(messages.testSuccess), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      setIsValidated(false);
      setResult({
        ...(readTestFailure(error) ?? { warnings: [] }),
        error: readSuwayomiError(error),
      });
      addToast(intl.formatMessage(messages.testFailure), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      if (testRequest.current === controller) {
        testRequest.current = null;
        setIsTesting(false);
      }
    }
  };

  const tooLong = (max: number) =>
    intl.formatMessage(messages.tooLong, { max });
  const credentialSchema = (max: number) =>
    Yup.string()
      .max(max, tooLong(max))
      .test(
        'line-break',
        intl.formatMessage(messages.lineBreak),
        (value) => !hasLineBreak(value)
      );
  const schema = Yup.object().shape({
    name: Yup.string()
      .test(
        'required',
        intl.formatMessage(sharedMessages.valueRequired),
        (value) => !!value?.trim()
      )
      .max(SUWAYOMI_MAX_TEXT_LENGTH, tooLong(SUWAYOMI_MAX_TEXT_LENGTH)),
    hostname: Yup.string().test(
      'hostname',
      intl.formatMessage(sharedMessages.validationHostnameRequired),
      (hostname, { parent }) => isValidHostname({ ...parent, hostname })
    ),
    port: Yup.mixed().test(
      'port',
      intl.formatMessage(sharedMessages.validationPortRequired),
      (port) => isValidPort(port)
    ),
    baseUrl: Yup.string().test(
      'base-url',
      intl.formatMessage(messages.invalidBaseUrl),
      (baseUrl) => isValidUrlBase(baseUrl)
    ),
    username: credentialSchema(SUWAYOMI_MAX_TEXT_LENGTH),
    password: credentialSchema(SUWAYOMI_MAX_PASSWORD_LENGTH),
    preferredLanguages: Yup.string().test(
      'languages',
      intl.formatMessage(messages.invalidLanguages, {
        max: SUWAYOMI_MAX_LANGUAGES,
      }),
      (value) => isValidLanguageList(value)
    ),
    scanlatorPreference: Yup.string().test(
      'scanlators',
      intl.formatMessage(messages.invalidScanlators, {
        max: SUWAYOMI_MAX_SCANLATORS,
        length: SUWAYOMI_MAX_SCANLATOR_LENGTH,
      }),
      (value) => isValidScanlatorList(value)
    ),
  });

  return (
    <Transition as="div" appear show>
      <Formik
        initialValues={suwayomiFormValues(suwayomi)}
        validationSchema={schema}
        onSubmit={async (values) => {
          if (!authMode) return;
          try {
            const submission = buildSaveRequest(values, authMode);
            if (suwayomi) {
              await axios.put(
                `/api/v1/settings/suwayomi/${suwayomi.id}`,
                submission
              );
            } else {
              await axios.post('/api/v1/settings/suwayomi', submission);
            }
            onSave();
          } catch (error) {
            addToast(
              describeSuwayomiError(
                intl,
                readSuwayomiError(error),
                messages.saveFailure
              ),
              { appearance: 'error', autoDismiss: true }
            );
          }
        }}
      >
        {({ values, handleSubmit, setFieldValue, isSubmitting, isValid }) => {
          const changeField = (
            field: keyof SuwayomiFormValues,
            value: unknown
          ) => {
            setFieldValue(field, value);
            if (resetsValidation(field)) {
              abortTest();
              setIsTesting(false);
              setIsValidated(false);
              setResult(null);
            }
            if (
              clearsStoredPassword(field) &&
              isRedactedSecret(values.password)
            ) {
              setFieldValue('password', '');
            }
          };

          return (
            <Modal
              onCancel={() => {
                abortTest();
                onClose();
              }}
              okButtonType="primary"
              okText={
                isSubmitting
                  ? intl.formatMessage(globalMessages.saving)
                  : suwayomi
                    ? intl.formatMessage(globalMessages.save)
                    : intl.formatMessage(messages.add)
              }
              okDisabled={
                !isValidated ||
                !authMode ||
                isSubmitting ||
                isTesting ||
                !isValid
              }
              onOk={() => handleSubmit()}
              secondaryButtonType="warning"
              secondaryText={intl.formatMessage(
                isTesting ? globalMessages.testing : globalMessages.test
              )}
              secondaryDisabled={
                !values.hostname || !values.port || isTesting || isSubmitting
              }
              onSecondary={() => testConnection(values)}
              title={intl.formatMessage(
                suwayomi ? messages.editServer : messages.addServer
              )}
            >
              <div className="mb-6">
                <div className="form-row">
                  <label htmlFor="name" className="text-label">
                    {intl.formatMessage(messages.name)}
                    <span className="label-required">*</span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field id="name" name="name" type="text" />
                    </div>
                    <FieldError name="name" />
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="hostname" className="text-label">
                    {intl.formatMessage(sharedMessages.hostname)}
                    <span className="label-required">*</span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <span className="protocol">
                        {values.useSsl ? 'https://' : 'http://'}
                      </span>
                      <Field
                        id="hostname"
                        name="hostname"
                        type="text"
                        inputMode="url"
                        className="rounded-r-only"
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                          changeField('hostname', e.target.value)
                        }
                      />
                    </div>
                    <FieldError name="hostname" />
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="port" className="text-label">
                    {intl.formatMessage(sharedMessages.port)}
                    <span className="label-required">*</span>
                  </label>
                  <div className="form-input-area">
                    <SettingsField
                      id="port"
                      name="port"
                      type="text"
                      inputMode="numeric"
                      className="short"
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                        changeField('port', e.target.value)
                      }
                    />
                    <FieldError name="port" />
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="useSsl" className="checkbox-label">
                    {intl.formatMessage(sharedMessages.enablessl)}
                  </label>
                  <div className="form-input-area">
                    <SettingsField
                      type="checkbox"
                      id="useSsl"
                      name="useSsl"
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                        changeField('useSsl', e.target.checked)
                      }
                    />
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="baseUrl" className="text-label">
                    {intl.formatMessage(sharedMessages.urlBase)}
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field
                        id="baseUrl"
                        name="baseUrl"
                        type="text"
                        inputMode="url"
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                          changeField('baseUrl', e.target.value)
                        }
                      />
                    </div>
                    <FieldError name="baseUrl" />
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="username" className="text-label">
                    {intl.formatMessage(messages.username)}
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field
                        id="username"
                        name="username"
                        type="text"
                        autoComplete="off"
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                          changeField('username', e.target.value)
                        }
                      />
                    </div>
                    <FieldError name="username" />
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="password" className="text-label">
                    {intl.formatMessage(messages.password)}
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <SensitiveInput
                        as="field"
                        id="password"
                        name="password"
                        autoComplete="new-password"
                        onFocus={(e: React.FocusEvent<HTMLInputElement>) => {
                          // Typing then replaces the stored-password marker.
                          if (isRedactedSecret(values.password)) {
                            e.target.select();
                          }
                        }}
                        onMouseUp={(e: React.MouseEvent<HTMLInputElement>) => {
                          if (isRedactedSecret(values.password)) {
                            e.preventDefault();
                          }
                        }}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                          changeField('password', e.target.value)
                        }
                      />
                    </div>
                    <FieldError name="password" />
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="requireCbz" className="checkbox-label">
                    {intl.formatMessage(messages.requireCbz)}
                  </label>
                  <div className="form-input-area">
                    <SettingsField
                      type="checkbox"
                      id="requireCbz"
                      name="requireCbz"
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                        changeField('requireCbz', e.target.checked)
                      }
                    />
                  </div>
                  <span className="settings-form-row-description">
                    {intl.formatMessage(messages.requireCbzTip)}
                  </span>
                </div>
                {result && <TestResultPanel result={result} />}
                <div className="form-row">
                  <label htmlFor="preferredLanguages" className="text-label">
                    {intl.formatMessage(messages.languages)}
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field
                        id="preferredLanguages"
                        name="preferredLanguages"
                        type="text"
                      />
                    </div>
                    <FieldError name="preferredLanguages" />
                  </div>
                  <span className="settings-form-row-description">
                    {intl.formatMessage(messages.languagesTip)}
                  </span>
                </div>
                <div className="form-row">
                  <label htmlFor="scanlatorPreference" className="text-label">
                    {intl.formatMessage(messages.scanlators)}
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field
                        as="textarea"
                        id="scanlatorPreference"
                        name="scanlatorPreference"
                        rows={3}
                      />
                    </div>
                    <FieldError name="scanlatorPreference" />
                  </div>
                  <span className="settings-form-row-description">
                    {intl.formatMessage(messages.scanlatorsTip)}
                  </span>
                </div>
                <SourcePicker
                  sources={result?.sources}
                  selected={values.sourceAllowlist}
                  onChange={(ids) => setFieldValue('sourceAllowlist', ids)}
                />
              </div>
            </Modal>
          );
        }}
      </Formik>
    </Transition>
  );
};

export default SuwayomiModal;
