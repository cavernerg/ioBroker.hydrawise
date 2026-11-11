import { expect } from 'chai';
import {
    dateStamp,
    dateValue,
    inactiveVolume,
    localizedNumber,
    localizedUnit,
    periodBounds,
    periodRange,
    sumFlow,
    summarizeRuns,
} from './hydrawise-v2';

const flowSensor = (value: number | null, unit: string | null = 'l'): any => ({
    model: { sensorType: 'FLOW' },
    flowSummary: value === null && unit === null ? null : { totalWaterVolume: { value, unit } },
});

const run = (zone: number, scheduled: number, reported: number | null, water: number, duration: number): any => ({
    runEvent: {
        zone: { id: zone },
        scheduledStartTime: { value: null, timestamp: scheduled },
        reportedStartTime: reported === null ? null : { value: null, timestamp: reported },
        reportedEndTime: reported === null ? null : { value: null, timestamp: reported + duration },
        reportedDuration: duration,
        reportedWaterUsage: { value: water, unit: 'l' },
    },
});

describe('hydrawise-v2 => periodBounds', () => {
    const reference = new Date(2026, 10, 11, 14, 30, 15);
    const bounds = periodBounds(reference);
    const seconds = (d: Date): number => Math.floor(d.getTime() / 1000);

    it('starts today at local midnight and ends now', () => {
        expect(bounds.todayStart).to.equal(seconds(new Date(2026, 10, 11)));
        expect(bounds.now).to.equal(seconds(reference));
    });

    it('covers all of yesterday without touching today', () => {
        expect(bounds.ydayStart).to.equal(seconds(new Date(2026, 10, 10)));
        expect(bounds.ydayEnd).to.equal(bounds.todayStart - 1);
    });

    it('reports the last seven days as the week', () => {
        expect(bounds.weekStart).to.equal(seconds(new Date(2026, 10, 5)));
    });

    it('starts month and year on their first day', () => {
        expect(bounds.monthStart).to.equal(seconds(new Date(2026, 10, 1)));
        expect(bounds.yearStart).to.equal(seconds(new Date(2026, 0, 1)));
    });

    it('crosses a month and a year boundary', () => {
        const newYear = periodBounds(new Date(2027, 0, 1, 0, 5));

        expect(newYear.ydayStart).to.equal(seconds(new Date(2026, 11, 31)));
        expect(newYear.weekStart).to.equal(seconds(new Date(2026, 11, 26)));
        expect(newYear.yearStart).to.equal(newYear.todayStart);
    });

    it('maps every period to its range', () => {
        expect(periodRange('today', bounds)).to.deep.equal([bounds.todayStart, bounds.now]);
        expect(periodRange('yesterday', bounds)).to.deep.equal([bounds.ydayStart, bounds.ydayEnd]);
        expect(periodRange('week', bounds)).to.deep.equal([bounds.weekStart, bounds.now]);
        expect(periodRange('month', bounds)).to.deep.equal([bounds.monthStart, bounds.now]);
        expect(periodRange('year', bounds)).to.deep.equal([bounds.yearStart, bounds.now]);
    });
});

describe('hydrawise-v2 => value helpers', () => {
    it('reads the number of a localized value', () => {
        expect(localizedNumber({ value: 12.5, unit: 'l' })).to.equal(12.5);
        expect(localizedNumber({ value: 0, unit: 'l' })).to.equal(0);
    });

    it('falls back when the API reported no number', () => {
        expect(localizedNumber(null)).to.equal(null);
        expect(localizedNumber({ value: null, unit: 'l' }, 0)).to.equal(0);
        expect(localizedNumber({ value: NaN, unit: 'l' }, 7)).to.equal(7);
    });

    it('reads the unit of a localized value', () => {
        expect(localizedUnit({ value: 1, unit: 'gal' })).to.equal('gal');
        expect(localizedUnit({ value: 1, unit: null }, 'l')).to.equal('l');
        expect(localizedUnit(undefined)).to.equal('');
    });

    it('prefers the timestamp of a DateTime', () => {
        expect(dateValue({ value: 'ignored', timestamp: 1789000000 })).to.equal(new Date(1789000000000).toISOString());
        expect(dateStamp({ value: 'ignored', timestamp: 1789000000 })).to.equal(1789000000000);
    });

    it('falls back to the text of a DateTime', () => {
        expect(dateValue({ value: '2026-11-11T10:00:00Z', timestamp: null })).to.equal('2026-11-11T10:00:00Z');
        expect(dateStamp({ value: '2026-11-11T10:00:00Z', timestamp: null })).to.equal(
            Date.parse('2026-11-11T10:00:00Z'),
        );
    });

    it('survives a missing DateTime', () => {
        expect(dateValue(null)).to.equal(null);
        expect(dateStamp(undefined)).to.equal(0);
        expect(dateStamp({ value: 'Unknown', timestamp: 0 })).to.equal(0);
    });
});

describe('hydrawise-v2 => sumFlow', () => {
    it('adds up the flow meters and ignores other sensors', () => {
        const summary = sumFlow([
            flowSensor(10.111),
            flowSensor(5.222),
            { model: { sensorType: 'LEVEL_OPEN' }, flowSummary: { totalWaterVolume: { value: 99, unit: 'l' } } },
        ]);

        expect(summary).to.deep.equal({ hasFlowSensor: true, hasValue: true, total: 15.33, unit: 'l' });
    });

    it('tells a null answer apart from a reading of zero', () => {
        const nothing = sumFlow([flowSensor(null, null)]);

        expect(nothing.hasFlowSensor).to.equal(true);
        expect(nothing.hasValue).to.equal(false);
        expect(nothing.total).to.equal(0);

        expect(sumFlow([flowSensor(0)]).hasValue).to.equal(true);
    });

    it('reports a controller without a flow meter', () => {
        expect(sumFlow([]).hasFlowSensor).to.equal(false);
        expect(sumFlow([{ model: { sensorType: 'LEVEL_CLOSED' } }, null]).hasFlowSensor).to.equal(false);
    });
});

describe('hydrawise-v2 => summarizeRuns', () => {
    it('adds up water and runtime per controller and per zone', () => {
        const summary = summarizeRuns([
            run(1, 100, 100, 20.5, 600),
            run(1, 5000, 5000, 10.25, 300),
            run(2, 200, 200, 4, 60),
        ]);

        expect(summary.active).to.equal(34.75);
        expect(summary.runtime).to.equal(960);
        expect(summary.unit).to.equal('l');
        expect(summary.byZone.get(1)).to.include({ water: 30.75, runtime: 900 });
        expect(summary.byZone.get(2)).to.include({ water: 4, runtime: 60 });
    });

    it('keeps the run that ended last as the last run of a zone', () => {
        const summary = summarizeRuns([run(1, 5000, 5000, 10, 300), run(1, 100, 100, 20, 600)]);

        expect(summary.byZone.get(1)?.last.reportedStartTime.timestamp).to.equal(5000);
    });

    it('does not count a run that was scheduled but never started', () => {
        const summary = summarizeRuns([run(1, 100, 100, 20, 600), run(1, 9000, null, 50, 900)]);
        const zone = summary.byZone.get(1);

        expect(summary.active).to.equal(20);
        expect(summary.runtime).to.equal(600);
        // ... but it is the most recent entry, and carries the reason it was skipped
        expect(zone?.latest.scheduledStartTime.timestamp).to.equal(9000);
        expect(zone?.last.reportedStartTime.timestamp).to.equal(100);
    });

    it('skips entries without a zone', () => {
        const summary = summarizeRuns([{ runEvent: null }, { runEvent: { zone: null } }, null]);

        expect(summary.byZone.size).to.equal(0);
        expect(summary.active).to.equal(0);
    });
});

describe('hydrawise-v2 => inactiveVolume', () => {
    const volume = (total: number): any => ({ hasFlowSensor: true, hasValue: true, total, unit: 'l' });
    const usage = (active: number): any => ({ active, runtime: 0, unit: 'l', byZone: new Map() });

    it('is the water that flowed outside of watering', () => {
        expect(inactiveVolume(volume(120.5), usage(100.25))).to.equal(20.25);
    });

    it('is never negative when the report is ahead of the flow meter', () => {
        expect(inactiveVolume(volume(80), usage(100))).to.equal(0);
        expect(inactiveVolume(volume(100), usage(100))).to.equal(0);
    });
});
