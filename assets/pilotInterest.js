export const PILOT_STORAGE_KEY = 'weekly-report-pilot-interest-records';

const SOURCE_KEYS = ['utm_source', 'source', 'channel', 'utm_medium', 'utm_campaign', 'campaign', 'utm_content', 'ref'];
const REQUIRED_FIELDS = ['name', 'email', 'role', 'institutionType', 'lms', 'courseSize', 'canExportData'];

export function sourceFromUrl(urlLike = globalThis.location?.href || '') {
  const url = new URL(urlLike || 'https://example.invalid');
  const source = {};
  for (const key of SOURCE_KEYS) {
    const value = url.searchParams.get(key);
    if (value) source[key] = value;
  }
  source.landingPath = `${url.pathname}${url.search || ''}`;
  return source;
}

export function createPilotRecord(formData, source = sourceFromUrl(), now = new Date()) {
  const record = {
    id: `pilot_${now.toISOString().replace(/[-:.TZ]/g, '')}_${randomSuffix()}`,
    submittedAt: now.toISOString(),
    name: clean(formData.name),
    email: clean(formData.email).toLowerCase(),
    role: clean(formData.role),
    institutionType: clean(formData.institutionType),
    lms: clean(formData.lms),
    courseSize: clean(formData.courseSize),
    canExportData: clean(formData.canExportData),
    courseProblem: clean(formData.courseProblem),
    privacyConcerns: normalizeList(formData.privacyConcerns),
    cohortOnlyPreference: Boolean(formData.cohortOnlyPreference),
    source: {
      source: source.source || source.utm_source || '',
      channel: source.channel || source.utm_medium || '',
      campaign: source.campaign || source.utm_campaign || '',
      content: source.utm_content || '',
      ref: source.ref || '',
      landingPath: source.landingPath || ''
    },
    studentDataRequested: false
  };

  const errors = validatePilotRecord(record);
  if (errors.length) {
    const error = new Error(errors.join('\n'));
    error.errors = errors;
    throw error;
  }
  return record;
}

export function validatePilotRecord(record) {
  const errors = [];
  for (const field of REQUIRED_FIELDS) {
    if (!record[field]) errors.push(`${label(field)} is required.`);
  }
  if (record.email && !/^\S+@\S+\.\S+$/.test(record.email)) errors.push('Enter a valid email address.');
  return errors;
}

export function savePilotRecord(record, storage = globalThis.localStorage) {
  const records = loadPilotRecords(storage);
  records.push(record);
  storage.setItem(PILOT_STORAGE_KEY, JSON.stringify(records, null, 2));
  return records;
}

export function loadPilotRecords(storage = globalThis.localStorage) {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(PILOT_STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function summarizePilotRecords(records) {
  return {
    total: records.length,
    byLms: countBy(records, (record) => record.lms || 'Unknown'),
    byRole: countBy(records, (record) => record.role || 'Unknown'),
    byPrivacyConcern: countBy(records.flatMap((record) => record.privacyConcerns.length ? record.privacyConcerns : ['None stated']), (value) => value),
    bySourceChannel: countBy(records, (record) => record.source?.channel || record.source?.source || 'Direct/unknown'),
    canExportData: countBy(records, (record) => record.canExportData || 'Unknown')
  };
}

export function recordsToCsv(records) {
  const headers = [
    'submittedAt',
    'name',
    'email',
    'role',
    'institutionType',
    'lms',
    'courseSize',
    'canExportData',
    'privacyConcerns',
    'cohortOnlyPreference',
    'source',
    'channel',
    'campaign',
    'landingPath',
    'courseProblem'
  ];
  const lines = [headers.join(',')];
  for (const record of records) {
    lines.push(headers.map((header) => csvValue(valueForHeader(record, header))).join(','));
  }
  return lines.join('\n');
}

export async function optionallyPostRecord(record, endpoint = globalThis.PILOT_INTEREST_ENDPOINT) {
  if (!endpoint) return { status: 'skipped' };
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(record)
  });
  if (!response.ok) throw new Error(`Pilot interest endpoint returned ${response.status}`);
  return { status: 'posted' };
}

function valueForHeader(record, header) {
  if (header === 'privacyConcerns') return record.privacyConcerns.join('; ');
  if (header === 'source') return record.source?.source || '';
  if (header === 'channel') return record.source?.channel || '';
  if (header === 'campaign') return record.source?.campaign || '';
  if (header === 'landingPath') return record.source?.landingPath || '';
  return record[header] ?? '';
}

function countBy(values, keyFn) {
  return values.reduce((counts, value) => {
    const key = keyFn(value);
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  if (!value) return [];
  return [clean(value)].filter(Boolean);
}

function clean(value) {
  return String(value ?? '').trim();
}

function csvValue(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function label(field) {
  return field.replace(/[A-Z]/g, (char) => ` ${char.toLowerCase()}`).replace(/^./, (char) => char.toUpperCase());
}

function randomSuffix() {
  if (globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(3);
    globalThis.crypto.getRandomValues(bytes);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return Math.random().toString(16).slice(2, 8).padEnd(6, '0');
}
