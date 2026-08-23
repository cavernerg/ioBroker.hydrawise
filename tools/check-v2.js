#!/usr/bin/env node
/*
 * Diagnostic helper for the Hydrawise v2 API.
 *
 * Reads the credentials from the instance configuration (they never appear on the
 * command line), runs every query the adapter uses and reports what the API answers.
 * Use it to verify the credentials and to see which parts of the API this account
 * is allowed to read, without touching the running adapter.
 *
 *   node tools/check-v2.js [instance]      # default instance: 0
 */

const { execFileSync } = require('node:child_process');
const { tools } = require('@iobroker/js-controller-common');
const { HydrawiseV2, periodBounds, localizedNumber, localizedUnit, dateValue } = require('../build/lib/hydrawise-v2');

const instance = process.argv[2] || '0';

function getObject(id) {
    const raw = execFileSync('/opt/iobroker/iobroker', ['object', 'get', id], { encoding: 'utf-8' });
    return JSON.parse(raw);
}

async function section(name, run) {
    process.stdout.write(`\n### ${name}\n`);
    try {
        const result = await run();
        console.log('  OK');
        return result;
    } catch (error) {
        console.log(`  FAILED: ${error.message}`);
        return null;
    }
}

function summarizeReport(entries) {
    let water = 0;
    let runtime = 0;
    let ran = 0;
    for (const entry of entries) {
        const run = entry.runEvent;
        if (!run?.reportedStartTime) {
            continue;
        }
        ran++;
        water += localizedNumber(run.reportedWaterUsage, 0);
        runtime += Number(run.reportedDuration) || 0;
    }
    return { entries: entries.length, ran, water: Math.round(water * 100) / 100, runtime };
}

async function main() {
    const secret = getObject('system.config').native.secret;
    const config = getObject(`system.adapter.hydrawise.${instance}`).native;

    if (!config.email || !config.password) {
        console.error('No e-mail/password configured for this instance - enter them in the admin UI first.');
        process.exit(1);
    }

    const password = config.password.startsWith('$/aes') ? tools.decrypt(secret, config.password) : config.password;

    console.log(`account   : ${config.email}`);
    console.log(`password  : ${'*'.repeat(8)} (${password.length} characters)`);

    const client = new HydrawiseV2(config.email, password, {
        debug: message => console.log(`  debug: ${message}`),
        info: message => console.log(`  info: ${message}`),
        warn: message => console.log(`  warn: ${message}`),
        error: message => console.log(`  error: ${message}`),
    });

    const controllers = await section('login + controllers', () => client.getControllers());

    if (!controllers || !controllers.length) {
        console.error('\nno controller returned - cannot continue');
        process.exit(1);
    }

    console.log(`  ${controllers.map(c => `${c.name} (id ${c.id})`).join(', ')}`);

    const controllerId = Number(config.v2ControllerId) > 0 ? Number(config.v2ControllerId) : controllers[0].id;
    const bounds = periodBounds();

    const snapshot = await section('snapshot (status, weather, sensors, zones)', () =>
        client.getSnapshot(controllerId),
    );

    if (snapshot) {
        const status = snapshot.status || {};
        console.log(`  controller : online=${snapshot.online ?? status.online} "${status.summary}"`);
        console.log(`  last contact: ${dateValue(status.lastContact) ?? dateValue(snapshot.lastContactTime)}`);
        console.log(`  hardware   : ${snapshot.hardware?.model?.name} fw ${snapshot.hardware?.version}`);

        const observations = snapshot.observationsSummary || {};
        console.log(
            `  weather    : rain24h=${localizedNumber(observations.rainfallLast24Hours)} ${localizedUnit(observations.rainfallLast24Hours)}` +
                ` rain7d=${localizedNumber(observations.rainfallLast168hours)} ${localizedUnit(observations.rainfallLast168hours)}` +
                ` temp=${localizedNumber(observations.currentTemperature)} ${localizedUnit(observations.currentTemperature)}`,
        );

        for (const sensor of snapshot.sensors || []) {
            console.log(
                `  sensor ${sensor.input?.number} (${sensor.input?.label}): "${sensor.name}" ${sensor.model?.sensorType}` +
                    ` active=${sensor.status?.active} waterFlow=${localizedNumber(sensor.status?.waterFlow)} ${localizedUnit(sensor.status?.waterFlow)}`,
            );
        }

        for (const zone of snapshot.zones || []) {
            const runs = zone.scheduledRuns || {};
            console.log(
                `  zone ${zone.number?.value} "${zone.name}" (id ${zone.id}) running=${!!runs.currentRun}` +
                    ` next=${dateValue(runs.nextRun?.startTime) ?? dateValue(zone.status?.nextRun)}` +
                    ` nextDuration=${runs.nextRun?.duration} normal=${runs.nextRun?.normalDuration}` +
                    ` balance=${zone.status?.relativeWaterBalance}%`,
            );
        }
    }

    for (const [name, from, until] of [
        ['today', bounds.todayStart, bounds.now],
        ['yesterday', bounds.ydayStart, bounds.ydayEnd],
        ['week', bounds.weekStart, bounds.now],
        ['month', bounds.monthStart, bounds.now],
        ['year', bounds.yearStart, bounds.now],
    ]) {
        const sensors = await section(`flow summary ${name}`, () => client.getFlowSummary(controllerId, from, until));

        if (sensors) {
            for (const sensor of sensors.filter(s => s.model?.sensorType === 'FLOW')) {
                const volume = sensor.flowSummary?.totalWaterVolume;
                console.log(
                    `  ${sensor.name}: ${localizedNumber(volume, 0)} ${localizedUnit(volume, '-')} (null = nothing flowed)`,
                );
            }
        }
    }

    for (const [name, from, until] of [
        ['today', bounds.todayStart, bounds.now],
        ['yesterday', bounds.ydayStart, bounds.ydayEnd],
    ]) {
        const entries = await section(`watering report ${name}`, () => client.getReport(controllerId, from, until));

        if (entries) {
            const summary = summarizeReport(entries);
            console.log(
                `  ${summary.entries} scheduled, ${summary.ran} actually ran, ${summary.water} l, ${summary.runtime} s`,
            );
            for (const entry of entries.slice(0, 8)) {
                const run = entry.runEvent;
                console.log(
                    `      zone ${run?.zone?.id} ${dateValue(run?.reportedStartTime) ?? '(not run)'}` +
                        ` ${run?.reportedDuration ?? '-'}s ${localizedNumber(run?.reportedWaterUsage) ?? '-'}` +
                        ` "${run?.reportedStatus?.label ?? run?.scheduledStatus?.label ?? ''}"`,
                );
            }
        }
    }

    console.log('\ndone');
}

main().catch(error => {
    console.error(`\nFAILED: ${error.name}: ${error.message}`);
    process.exit(1);
});
