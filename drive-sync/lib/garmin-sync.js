import { GoogleRequestError, googleJson, googleRequest } from './google-drive.js';

export const ZONE = 'Asia/Novosibirsk';
const GARMIN = 'https://personal.connectapi.garmin.com';
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const DAY = 86_400_000;

export function localDate(date) {
  const fields = Object.fromEntries(formatter.formatToParts(date).map(p => [p.type, p.value]));
  return [fields.year, fields.month, fields.day].join('-');
}

export function shiftDate(date, offset) {
  return new Date(Date.parse(date + 'T00:00:00Z') + offset * DAY).toISOString().slice(0, 10);
}

export function completedDates(now) {
  const today = localDate(now);
  return [-3, -2, -1].map(offset => shiftDate(today, offset));
}

const fields = (object, keys) => Object.fromEntries(keys.filter(key => object?.[key] != null).map(key => [key, object[key]]));
const present = value => Number.isFinite(value) && value > 0;
const rowsPresent = rows => Array.isArray(rows) && rows.some(row => Array.isArray(row) && present(row[1]));
const mismatch = () => { throw new Error('unexpected_garmin_shape'); };
const checkDate = (value, date) => { if (value?.calendarDate && value.calendarDate !== date) mismatch(); };

function metric(value, date, keys, hasData) {
  if (value == null) return null;
  if (Array.isArray(value) || typeof value !== 'object') mismatch();
  checkDate(value, date);
  return hasData(value) ? fields(value, keys) : null;
}

export function garminClient(apiKey, request) {
  let token;
  async function setToken() {
    const response = await googleRequest(request, 'garmin_auth', GARMIN + '/personalapitoken-service/personal-api/personal-api-key/token', {
      method: 'POST', headers: { Authorization: 'ApiKey ' + apiKey },
    });
    let raw = (await response.text()).trim().replace(/^"|"$/g, '');
    if (raw.startsWith('{')) {
      const obj = JSON.parse(raw);
      raw = obj.access_token ?? obj.accessToken ?? obj.token;
    }
    if (typeof raw !== 'string' || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(raw)) mismatch();
    return raw;
  }
  return async function get(path, params = {}) {
    const url = GARMIN + path + '?' + new URLSearchParams(params);
    const current = await (token ??= setToken());
    const call = value => googleRequest(request, 'garmin_request', url, { headers: { Authorization: 'Bearer ' + value } }, [401]);
    let response = await call(current);
    if (response.status === 401) {
      await response.body?.cancel();
      if (await token === current) token = setToken();
      response = await call(await token);
      if (response.status === 401) {
        await response.body?.cancel();
        throw new GoogleRequestError('garmin_request', 401);
      }
    }
    if (response.status === 204) return null;
    const result = await googleJson(response, 'garmin_request');
    return result?.noData === true ? null : result;
  };
}

export const METRICS = ['hrv', 'spo2', 'sleep', 'heartRate', 'steps', 'activity', 'workouts'];

export async function collectDay(get, date) {
  const tasks = {
    hrv: async () => {
      const h = await get('/hrv-service/hrv/' + date);
      const summary = metric(h?.hrvSummary, date, ['lastNightAvg', 'lastNight5MinHigh', 'weeklyAvg', 'baseline', 'status'],
        v => present(v.lastNightAvg));
      return summary && { ...summary, readings: h.hrvReadings?.filter(row => present(row?.hrvValue)).map(row =>
        fields(row, ['hrvValue', 'readingTimeGMT'])) ?? [] };
    },
    spo2: async () => metric(await get('/wellness-service/wellness/daily/spo2acclimation/' + date), date,
      ['avgSleepSpO2', 'averageSpO2', 'lowestSpO2', 'spO2HourlyAverages', 'spO2HourlyAveragesDescriptorList'],
      v => [v.avgSleepSpO2, v.averageSpO2, v.lowestSpO2].some(present)),
    sleep: async () => metric(await get('/sleep-service/sleep/dailySleep', { date }), date,
      ['sleepTimeSeconds', 'napTimeSeconds', 'deepSleepSeconds', 'lightSleepSeconds', 'remSleepSeconds',
        'awakeSleepSeconds', 'sleepStartTimestampGMT', 'sleepEndTimestampGMT', 'sleepScores', 'avgHeartRate',
        'averageSpO2Value', 'lowestSpO2Value', 'sleepWindowConfirmed'], v => present(v.sleepTimeSeconds)),
    heartRate: async () => metric(await get('/wellness-service/wellness/dailyHeartRate', { date }), date,
      ['restingHeartRate', 'minHeartRate', 'maxHeartRate', 'heartRateValues', 'heartRateValueDescriptors'],
      v => [v.restingHeartRate, v.minHeartRate, v.maxHeartRate].some(present) || rowsPresent(v.heartRateValues)),
    steps: async () => {
      const result = await get('/usersummary-service/stats/steps/daily/' + date + '/' + date);
      if (result == null) return null;
      if (!Array.isArray(result) || result.length > 1) mismatch();
      return metric(result[0], date, ['totalSteps', 'totalDistance', 'stepGoal'], v =>
        Number.isInteger(v.totalSteps) && v.totalSteps >= 0);
    },
    activity: async () => metric(await get('/usersummary-service/usersummary/daily', { calendarDate: date }), date,
      ['totalKilocalories', 'activeKilocalories', 'bmrKilocalories', 'totalDistanceMeters', 'highlyActiveSeconds',
        'activeSeconds', 'sedentarySeconds', 'moderateIntensityMinutes', 'vigorousIntensityMinutes',
        'floorsAscended', 'includesWellnessData', 'includesActivityData', 'lastSyncTimestampGMT',
        'bodyBatteryHighestValue', 'bodyBatteryLowestValue', 'bodyBatteryAtWakeTime', 'averageStressLevel'],
      v => v.includesWellnessData === true || v.includesActivityData === true || present(v.activeSeconds)),
    workouts: async () => training(get, date),
  };
  const result = await Promise.allSettled(METRICS.map(key => tasks[key]()));
  return Object.fromEntries(result.map((item, i) => [METRICS[i], item.status === 'rejected'
    ? { status: 'error', code: Number.isInteger(item.reason?.status) ? item.reason.status : null,
        stage: ['garmin_auth', 'garmin_request'].includes(item.reason?.stage) ? item.reason.stage : 'garmin_shape' }
    : item.value === null ? { status: 'no_data' } : { status: 'ok', data: item.value }]));
}

async function training(get, date) {
  const records = new Map();
  let duplicates = 0;
  const sorted = () => [...records].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row);
  const limit = 100;
  for (let start = 0; start < 1000; start += limit) {
    const rows = await get('/activitylist-service/activities/search/activities', {
      startDate: shiftDate(date, -1), endDate: shiftDate(date, 1), start, limit, excludeChildren: true,
    });
    if (rows == null) return start === 0 ? null : { records: sorted(), duplicates };
    if (!Array.isArray(rows)) mismatch();
    for (const row of rows) {
      const timestamp = String(row?.startTimeGMT ?? '').replace(' ', 'T');
      const instant = new Date(/[zZ]$|[+-]\d\d:\d\d$/.test(timestamp) ? timestamp : timestamp + 'Z');
      if (!Number.isFinite(instant.getTime()) || !row.activityId) mismatch();
      if (localDate(instant) !== date) continue;
      const id = String(row.activityId);
      if (records.has(id)) { duplicates++; continue; }
      records.set(id, fields(row, ['activityId', 'activityName', 'startTimeGMT', 'activityType', 'duration',
        'movingDuration', 'distance', 'elevationGain', 'calories', 'averageHR', 'maxHR', 'aerobicTrainingEffect',
        'anaerobicTrainingEffect', 'activityTrainingLoad', 'lapCount']));
    }
    if (rows.length < limit) return { records: sorted(), duplicates };
  }
  mismatch();
}
