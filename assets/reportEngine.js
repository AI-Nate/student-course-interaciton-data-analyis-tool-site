const REQUIRED_FIELDS = [
  'student_id',
  'student_name',
  'week',
  'activity_minutes',
  'prior_activity_minutes',
  'discussion_posts',
  'resource_views',
  'expected_resource_views',
  'assignment_name',
  'submission_status',
  'grade_percent',
  'resource_name'
];

const STATUS_WEIGHTS = {
  missing: 3,
  late: 2,
  submitted: 0,
  on_time: 0,
  'on time': 0,
  complete: 0
};

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && quoted && next === '"') {
      value += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(value.trim());
      value = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(value.trim());
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = [];
      value = '';
    } else {
      value += char;
    }
  }

  row.push(value.trim());
  if (row.some((cell) => cell !== '')) rows.push(row);
  if (!rows.length) return [];

  const headers = rows[0].map(normalizeKey);
  return rows.slice(1).map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ''])));
}

export function validateRows(rows) {
  if (!rows.length) return ['Import at least one row of course interaction data.'];
  const present = new Set(Object.keys(rows[0]));
  return REQUIRED_FIELDS.filter((field) => !present.has(field)).map((field) => `Missing required column: ${field}`);
}

export function generateWeeklyReport(rows, options = {}) {
  const errors = validateRows(rows);
  if (errors.length) throw new Error(errors.join('\n'));

  const week = options.week || rows[0].week || 'Selected week';
  const courseName = options.courseName || inferValue(rows, 'course_name') || 'Imported course';
  const dataFreshness = options.dataFreshness || inferValue(rows, 'data_freshness') || new Date().toISOString();
  const authorized = options.authorizedStudentView !== false;

  const studentMap = new Map();
  for (const row of rows) {
    const key = row.student_id || row.student_name;
    if (!studentMap.has(key)) {
      studentMap.set(key, {
        id: row.student_id,
        name: row.student_name,
        rows: [],
        activity: 0,
        priorActivity: 0,
        discussionPosts: 0,
        resourceViews: 0,
        expectedResourceViews: 0,
        grades: [],
        statuses: []
      });
    }
    const student = studentMap.get(key);
    student.rows.push(row);
    student.activity += number(row.activity_minutes);
    student.priorActivity += number(row.prior_activity_minutes);
    student.discussionPosts += number(row.discussion_posts);
    student.resourceViews += number(row.resource_views);
    student.expectedResourceViews += number(row.expected_resource_views);
    student.grades.push(number(row.grade_percent));
    student.statuses.push(normalizeStatus(row.submission_status));
  }

  const students = [...studentMap.values()].map(scoreStudent).sort((a, b) => b.riskScore - a.riskScore);
  const flaggedStudents = students.filter((student) => student.riskScore >= 3).slice(0, 8);
  const troubleSpots = detectTroubleSpots(rows).slice(0, 6);
  const recommendations = recommendActions(flaggedStudents, troubleSpots, rows).slice(0, 3);

  return {
    courseName,
    week,
    generatedAt: new Date().toISOString(),
    dataFreshness,
    privacyNote: 'This report uses course activity, discussion, resource-view, submission, and grade signals. Cohort patterns are shown first; student names should be viewed only by authorized lecturer/advisor roles.',
    dataUsed: ['activity minutes', 'discussion posts', 'resource views', 'submission status', 'assignment grades'],
    cohortSummary: summarizeCohort(rows, students),
    studentsNeedingAttention: authorized ? flaggedStudents : flaggedStudents.map(redactStudent),
    coursePathTroubleSpots: troubleSpots,
    recommendations
  };
}

export function reportToText(report) {
  const lines = [
    `Weekly learning-path report: ${report.courseName}`,
    `Week: ${report.week}`,
    `Data freshness: ${formatDate(report.dataFreshness)}`,
    `Privacy note: ${report.privacyNote}`,
    '',
    'Cohort snapshot',
    `- ${report.cohortSummary.totalStudents} students represented in the import.`,
    `- ${report.cohortSummary.atRiskCount} students show low or worsening interaction signals.`,
    `- ${report.cohortSummary.lateOrMissingRate}% of assignment records are late or missing.`,
    '',
    'Students needing attention',
    ...formatStudents(report.studentsNeedingAttention),
    '',
    'Where the course path is breaking',
    ...formatTroubleSpots(report.coursePathTroubleSpots),
    '',
    'Recommended teaching actions this week',
    ...report.recommendations.map((rec, index) => `${index + 1}. ${rec.action}\n   Evidence: ${rec.evidence}\n   Why this matters: ${rec.whyThisMatters}`)
  ];
  return lines.join('\n');
}

function scoreStudent(student) {
  const reasons = [];
  let riskScore = 0;
  const missing = student.statuses.filter((status) => status === 'missing').length;
  const late = student.statuses.filter((status) => status === 'late').length;
  const avgGrade = average(student.grades);
  const viewRate = percentage(student.resourceViews, Math.max(student.expectedResourceViews, 1));
  const activityDrop = student.priorActivity > 0 ? Math.round(((student.priorActivity - student.activity) / student.priorActivity) * 100) : 0;

  if (missing) {
    riskScore += missing * 3;
    reasons.push(`${missing} missing submission${missing === 1 ? '' : 's'}`);
  }
  if (late) {
    riskScore += late * 2;
    reasons.push(`${late} late submission${late === 1 ? '' : 's'}`);
  }
  if (student.discussionPosts === 0) {
    riskScore += 2;
    reasons.push('no discussion participation recorded');
  }
  if (viewRate < 60) {
    riskScore += 2;
    reasons.push(`viewed ${viewRate}% of expected resources`);
  }
  if (activityDrop >= 35) {
    riskScore += 2;
    reasons.push(`activity fell ${activityDrop}% from the prior week`);
  }
  if (avgGrade < 65) {
    riskScore += 2;
    reasons.push(`average grade is ${Math.round(avgGrade)}%`);
  }

  return {
    id: student.id,
    name: student.name,
    riskScore,
    reasons,
    evidence: {
      activityMinutes: student.activity,
      priorActivityMinutes: student.priorActivity,
      discussionPosts: student.discussionPosts,
      resourceViewRate: viewRate,
      averageGrade: Math.round(avgGrade),
      lateSubmissions: late,
      missingSubmissions: missing
    }
  };
}

function detectTroubleSpots(rows) {
  const grouped = groupBy(rows, (row) => `${row.assignment_name || 'General'}|${row.resource_name || 'Unspecified resource'}`);
  return [...grouped.entries()].map(([key, spotRows]) => {
    const [assignmentName, resourceName] = key.split('|');
    const total = spotRows.length;
    const lateOrMissing = spotRows.filter((row) => ['late', 'missing'].includes(normalizeStatus(row.submission_status))).length;
    const lowViews = spotRows.filter((row) => number(row.resource_views) < Math.max(1, number(row.expected_resource_views) * 0.6)).length;
    const weakGrades = spotRows.filter((row) => number(row.grade_percent) < 65).length;
    const lowDiscussion = spotRows.filter((row) => number(row.discussion_posts) === 0).length;
    const severity = lateOrMissing * 3 + lowViews * 2 + weakGrades * 2 + lowDiscussion;
    const signals = [];
    if (lateOrMissing) signals.push(`${percent(lateOrMissing, total)}% late or missing submissions`);
    if (lowViews) signals.push(`${percent(lowViews, total)}% low resource access`);
    if (weakGrades) signals.push(`${percent(weakGrades, total)}% below 65% grade`);
    if (lowDiscussion) signals.push(`${percent(lowDiscussion, total)}% with no discussion posts`);
    return {
      assignmentName,
      resourceName,
      affectedStudents: total,
      severity,
      signals,
      interpretation: signals.length
        ? `${resourceName} / ${assignmentName} may need clearer scaffolding or timing support.`
        : `${resourceName} / ${assignmentName} is not showing a cohort-level issue in this import.`
    };
  }).filter((spot) => spot.severity > 0).sort((a, b) => b.severity - a.severity);
}

function recommendActions(flaggedStudents, troubleSpots, rows) {
  const recommendations = [];
  const topSpot = troubleSpots[0];
  if (topSpot) {
    const strongestSignal = topSpot.signals[0] || 'multiple weak interaction signals';
    recommendations.push({
      priority: 'high',
      action: `Add a short worked example or clarification before ${topSpot.assignmentName}.`,
      evidence: `${strongestSignal} around ${topSpot.resourceName} / ${topSpot.assignmentName}.`,
      whyThisMatters: 'When many students struggle at the same point, a course-path fix can help the whole cohort instead of treating every case as an individual problem.'
    });
  }

  const noDiscussion = rows.filter((row) => number(row.discussion_posts) === 0).length;
  if (percent(noDiscussion, rows.length) >= 30) {
    recommendations.push({
      priority: 'medium',
      action: 'Post one focused mid-week discussion prompt and model a strong first reply.',
      evidence: `${percent(noDiscussion, rows.length)}% of imported records show no discussion participation this week.`,
      whyThisMatters: 'A timely prompt lowers the barrier to participation and gives quiet students a concrete way back into the course path.'
    });
  }

  const missingOrLate = rows.filter((row) => ['late', 'missing'].includes(normalizeStatus(row.submission_status))).length;
  if (missingOrLate) {
    recommendations.push({
      priority: 'medium',
      action: 'Use office hours or advising time for a targeted check-in with the highest-need students.',
      evidence: `${flaggedStudents.length} students are flagged, and ${percent(missingOrLate, rows.length)}% of assignment records are late or missing.`,
      whyThisMatters: 'The report gives observable reasons for outreach, so the conversation can focus on the immediate blocker rather than a vague risk label.'
    });
  }

  if (recommendations.length < 2) {
    recommendations.push({
      priority: 'low',
      action: 'Share the cohort snapshot with an instructional designer and choose one small course-path experiment for next week.',
      evidence: 'The import shows enough activity, grade, resource, and submission data to review patterns without adding new student-facing tools.',
      whyThisMatters: 'Small weekly adjustments are easier to evaluate and avoid overreacting to a single metric.'
    });
  }

  return recommendations;
}

function summarizeCohort(rows, students) {
  const lateOrMissing = rows.filter((row) => ['late', 'missing'].includes(normalizeStatus(row.submission_status))).length;
  return {
    totalStudents: students.length,
    atRiskCount: students.filter((student) => student.riskScore >= 3).length,
    lateOrMissingRate: percent(lateOrMissing, rows.length),
    averageResourceViewRate: Math.round(average(students.map((student) => student.evidence.resourceViewRate)))
  };
}

function formatStudents(students) {
  if (!students.length) return ['- No students crossed the attention threshold in this import.'];
  return students.map((student) => `- ${student.name || student.id}: ${student.reasons.join('; ')}.`);
}

function formatTroubleSpots(spots) {
  if (!spots.length) return ['- No cohort-level course-path trouble spot crossed the threshold in this import.'];
  return spots.map((spot) => `- ${spot.resourceName} / ${spot.assignmentName}: ${spot.signals.join('; ')}. ${spot.interpretation}`);
}

function redactStudent(student, index) {
  return {
    ...student,
    id: `student-${index + 1}`,
    name: `Student ${index + 1}`
  };
}

function normalizeKey(key) {
  return key.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function normalizeStatus(value) {
  const status = String(value || '').trim().toLowerCase().replace(/[-_]+/g, ' ');
  if (status.includes('missing')) return 'missing';
  if (status.includes('late')) return 'late';
  if (status.includes('submit') || status.includes('complete') || status.includes('on time')) return 'submitted';
  return status || 'unknown';
}

function number(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function average(values) {
  const clean = values.map(number).filter((value) => Number.isFinite(value));
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : 0;
}

function percentage(numerator, denominator) {
  return denominator ? Math.round((numerator / denominator) * 100) : 0;
}

function percent(numerator, denominator) {
  return Math.round((numerator / Math.max(denominator, 1)) * 100);
}

function groupBy(values, keyFn) {
  return values.reduce((map, value) => {
    const key = keyFn(value);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
    return map;
  }, new Map());
}

function inferValue(rows, key) {
  return rows.find((row) => row[key])?.[key];
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
