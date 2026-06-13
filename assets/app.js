import { generateWeeklyReport, parseCsv, reportToText, validateRows } from './reportEngine.js';
import { createPilotRecord, loadPilotRecords, optionallyPostRecord, recordsToCsv, savePilotRecord, sourceFromUrl, summarizePilotRecords } from './pilotInterest.js';

const state = {
  rows: [],
  report: null,
  authorizedStudentView: true
};

const elements = {
  file: document.querySelector('#csv-file'),
  courseName: document.querySelector('#course-name'),
  week: document.querySelector('#week'),
  freshness: document.querySelector('#freshness'),
  authorized: document.querySelector('#authorized-view'),
  loadSample: document.querySelector('#load-sample'),
  generate: document.querySelector('#generate-report'),
  copy: document.querySelector('#copy-report'),
  print: document.querySelector('#print-report'),
  status: document.querySelector('#import-status'),
  report: document.querySelector('#report'),
  pilotForm: document.querySelector('#pilot-form'),
  pilotStatus: document.querySelector('#pilot-status'),
  pilotSummary: document.querySelector('#pilot-summary'),
  copyPilotRequest: document.querySelector('#copy-pilot-request'),
  downloadPilotJson: document.querySelector('#download-pilot-json'),
  downloadPilotCsv: document.querySelector('#download-pilot-csv')
};

elements.file.addEventListener('change', async (event) => {
  const [file] = event.target.files;
  if (!file) return;
  await importCsv(await file.text(), file.name);
});

elements.loadSample.addEventListener('click', async () => {
  const response = await fetch('./data/sample-course-week.csv');
  await importCsv(await response.text(), 'sample-course-week.csv');
});

elements.generate.addEventListener('click', () => {
  try {
    state.authorizedStudentView = elements.authorized.checked;
    state.report = generateWeeklyReport(state.rows, {
      courseName: elements.courseName.value,
      week: elements.week.value,
      dataFreshness: elements.freshness.value,
      authorizedStudentView: state.authorizedStudentView
    });
    renderReport(state.report);
    setStatus('Report generated. You can copy text or export to PDF with Print.', 'success');
  } catch (error) {
    setStatus(error.message, 'error');
  }
});

elements.copy.addEventListener('click', async () => {
  if (!state.report) return;
  await navigator.clipboard.writeText(reportToText(state.report));
  setStatus('Copyable report text is on your clipboard.', 'success');
});

elements.print.addEventListener('click', () => window.print());

elements.pilotForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = pilotFormData(new FormData(elements.pilotForm));
  try {
    const record = createPilotRecord(formData, sourceFromUrl(window.location.href));
    savePilotRecord(record);
    state.lastPilotRecord = record;
    elements.copyPilotRequest.disabled = false;
    renderPilotSummary();
    await optionallyPostRecord(record);
    setPilotStatus('Thanks — your pilot interest was recorded. Next, we will review your LMS/data availability and may follow up about a sample report. No automated student outreach will happen.', 'success');
    elements.pilotForm.reset();
  } catch (error) {
    setPilotStatus(error.message, 'error');
  }
});

elements.copyPilotRequest.addEventListener('click', async () => {
  if (!state.lastPilotRecord) return;
  await navigator.clipboard.writeText(JSON.stringify(state.lastPilotRecord, null, 2));
  setPilotStatus('Pilot request copied as JSON.', 'success');
});

elements.downloadPilotJson.addEventListener('click', () => downloadText('pilot-interest-records.json', JSON.stringify(loadPilotRecords(), null, 2), 'application/json'));
elements.downloadPilotCsv.addEventListener('click', () => downloadText('pilot-interest-records.csv', recordsToCsv(loadPilotRecords()), 'text/csv'));

renderPilotSummary();

async function importCsv(text, label) {
  try {
    state.rows = parseCsv(text);
    const errors = validateRows(state.rows);
    if (errors.length) {
      setStatus(`Could not import ${label}: ${errors.join('; ')}`, 'error');
      elements.generate.disabled = true;
      return;
    }
    elements.generate.disabled = false;
    elements.courseName.value = state.rows[0].course_name || elements.courseName.value || 'Course import';
    elements.week.value = state.rows[0].week || elements.week.value;
    elements.freshness.value = state.rows[0].data_freshness || new Date().toISOString().slice(0, 16);
    setStatus(`Imported ${state.rows.length} records from ${label}.`, 'success');
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

function renderReport(report) {
  elements.copy.disabled = false;
  elements.print.disabled = false;
  elements.report.innerHTML = `
    <section class="report-cover">
      <p class="eyebrow">Weekly lecturer learning-path report</p>
      <h2>${escapeHtml(report.courseName)}</h2>
      <dl class="meta-grid">
        <div><dt>Week</dt><dd>${escapeHtml(report.week)}</dd></div>
        <div><dt>Data freshness</dt><dd>${formatDate(report.dataFreshness)}</dd></div>
        <div><dt>Generated</dt><dd>${formatDate(report.generatedAt)}</dd></div>
      </dl>
      <p class="privacy-note"><strong>Privacy note:</strong> ${escapeHtml(report.privacyNote)}</p>
      <p class="data-note"><strong>Data used:</strong> ${report.dataUsed.map(escapeHtml).join(', ')}</p>
    </section>
    <section class="cards" aria-label="Cohort snapshot">
      ${metricCard(report.cohortSummary.totalStudents, 'students in import')}
      ${metricCard(report.cohortSummary.atRiskCount, 'students needing attention')}
      ${metricCard(`${report.cohortSummary.lateOrMissingRate}%`, 'late or missing records')}
      ${metricCard(`${report.cohortSummary.averageResourceViewRate}%`, 'average resource-view rate')}
    </section>
    ${section('Students needing attention', report.studentsNeedingAttention.map(studentCard).join('') || '<p>No students crossed the attention threshold.</p>')}
    ${section('Where the course path is breaking', report.coursePathTroubleSpots.map(spotCard).join('') || '<p>No cohort-level course-path issue crossed the threshold.</p>')}
    ${section('Recommended teaching actions this week', report.recommendations.map(recommendationCard).join(''))}
  `;
}

function section(title, body) {
  return `<section class="report-section"><h3>${title}</h3>${body}</section>`;
}

function metricCard(value, label) {
  return `<article class="metric-card"><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(label)}</span></article>`;
}

function studentCard(student) {
  return `<article class="report-item">
    <h4>${escapeHtml(student.name || student.id)}</h4>
    <p>${student.reasons.map(escapeHtml).join('; ')}</p>
    <small>Evidence: ${student.evidence.activityMinutes} activity minutes, ${student.evidence.discussionPosts} discussion posts, ${student.evidence.resourceViewRate}% resource-view rate, ${student.evidence.averageGrade}% average grade.</small>
  </article>`;
}

function spotCard(spot) {
  return `<article class="report-item">
    <h4>${escapeHtml(spot.resourceName)} / ${escapeHtml(spot.assignmentName)}</h4>
    <p>${spot.signals.map(escapeHtml).join('; ')}</p>
    <small>${escapeHtml(spot.interpretation)}</small>
  </article>`;
}

function recommendationCard(recommendation) {
  return `<article class="report-item recommendation ${recommendation.priority}">
    <h4>${escapeHtml(recommendation.action)}</h4>
    <p><strong>Evidence:</strong> ${escapeHtml(recommendation.evidence)}</p>
    <p><strong>Why this matters:</strong> ${escapeHtml(recommendation.whyThisMatters)}</p>
  </article>`;
}

function setStatus(message, type) {
  elements.status.textContent = message;
  elements.status.dataset.type = type;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? escapeHtml(value) : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' })[char]);
}


function pilotFormData(formData) {
  return {
    name: formData.get('name'),
    email: formData.get('email'),
    role: formData.get('role'),
    institutionType: formData.get('institutionType'),
    lms: formData.get('lms'),
    courseSize: formData.get('courseSize'),
    canExportData: formData.get('canExportData'),
    courseProblem: formData.get('courseProblem'),
    privacyConcerns: formData.getAll('privacyConcerns'),
    cohortOnlyPreference: formData.get('cohortOnlyPreference') === 'true'
  };
}

function renderPilotSummary() {
  const summary = summarizePilotRecords(loadPilotRecords());
  elements.pilotSummary.innerHTML = [
    summaryCard(summary.total, 'total pilot records'),
    summaryCard(formatCounts(summary.byLms), 'by LMS'),
    summaryCard(formatCounts(summary.byRole), 'by role'),
    summaryCard(formatCounts(summary.byPrivacyConcern), 'by privacy concern'),
    summaryCard(formatCounts(summary.bySourceChannel), 'by source/channel'),
    summaryCard(formatCounts(summary.canExportData), 'CSV/activity export readiness')
  ].join('');
}

function summaryCard(value, label) {
  return `<article class="metric-card compact"><strong>${escapeHtml(String(value || '—'))}</strong><span>${escapeHtml(label)}</span></article>`;
}

function formatCounts(counts) {
  const entries = Object.entries(counts);
  return entries.length ? entries.map(([key, value]) => `${key}: ${value}`).join(' · ') : '—';
}

function downloadText(filename, text, type) {
  const blob = new Blob([text], { type });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function setPilotStatus(message, type) {
  elements.pilotStatus.textContent = message;
  elements.pilotStatus.dataset.type = type;
}
