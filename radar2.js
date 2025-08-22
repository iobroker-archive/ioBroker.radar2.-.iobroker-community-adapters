/**
 *      iobroker radar2 Adapter
 *      (c) 2016- <frankjoke@hotmail.com>
 *      MIT License
 *      v 1.5.0 May 2020
 */
/* eslint-env node,es6 */
/*jslint node: true, bitwise: true, sub:true */
/* @ts-ignore:80006 */

'use strict';

const A = require('./fjadapter-core'),
    xml2js = require('xml2js');
const {
    Network,
    Bluetooth
} = require('./myNetworks');

const scanList = {},
    ipList = {},
    macList = {},
    btList = {},
    scansBTs = {},
    network = new Network(),
    bluetooth = new Bluetooth();
let scanDelay = 30 * 1000, // in ms = 30 sec
    printerDelay = 100,
    delayAway = 10,
    arpcmd = null,
    doArp = false,
    doUwz = null,
    suBt = false,
    suIp = true,
    ukBt = {},
    ukIp = {},
    knownIPs = [],
    knownBTs = [],
    wlast = null,
    lang = '',
    numuwz = 0,
    delayuwz = 0,
    longuwz = false,
    btid = 0,
    scanBt = false,
    devices = null;

const isTesting = process.env.DEBUG && process.env.DEBUG.startsWith('testing:');

A.init(module, {
    name: 'radar2',
    onUnload: async (how) => {
        await network.stop().catch(A.nop);
        await bluetooth.stop().catch(A.nop);
        A.timer.forEach(t => clearInterval(t));
        A.timer = [];
        return A.If('Unload adapter now with %s', how);
    },
    // async objChange(id, obj) {
    //     A.Df("Should change obj %s to %O", id, obj);
    // },
}, main);



async function xmlParseString(body) {
    try {
        const res = await A.c2p(new xml2js.Parser({
            explicitArray: false,
            trim: true,
            tagNameProcessors: [item => ((item = item.split(':')), item.length == 2 ? item[1] : item[0])],
            //                attrNameProcessors: [tagnames],  // can but not must be same as tagNameProcessor
            valueProcessors: [str => !isNaN(str) ? (str % 1 === 0 ? parseInt(str) : parseFloat(str)) : str]
        }).parseString)(body);
        return res;
    } catch (e) {
        A.Df('ParseXML-Error: %O', e);
        return null;
    }
}

async function scanExtIP() {
    const oldip = await Network.getExtIP();
    let state = await A.myGetState('_ExternalNetwork');
    if (state) try {
        const time = Date.now();
        if (state && state.val)
            state = state.val;
        if (oldip !== '' && state !== oldip) {
            A.I(`New external IP address ${oldip}`, oldip);
            await A.makeState('_ExternalNetwork.lastChanged', A.dateTime(new Date(time)), true);
        } else if (oldip === '') {
            await A.makeState('_ExternalNetwork.lastChanged', A.W(`Not connected to external network!`, 0), true);
        } else
            A.D(`Same external IP address ${oldip}`);
        await A.makeState('_ExternalNetwork', oldip, true);
        //                .then(() => A.makeState('ExternalNetwork.status', ++sameip));
    } catch (err) {
        A.If('scanExtIP error: %O', err);
    }
    return null;
}

async function scanECBs() {
    for (const item of devices)
        if (item.type === 'ECB' && !!item.enabled) try {
            const idn = item.id + '.';
            //    A.I(`ScanECB: ${item.id}`);
            const body = await A.get('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml', 2);
            const ecb = await xmlParseString(body);
            if (ecb && ecb.Envelope.Cube.Cube) {
                await A.makeState(item.id, ecb.Envelope.Cube.Cube.$.time, true);
                for (const cur of ecb.Envelope.Cube.Cube.Cube) {
                    const ccur = cur.$.currency;
                    const rate = parseFloat(cur.$.rate);
                    if (item.ip.indexOf(ccur) < 0)
                        continue;
                    await A.makeState(idn + ccur, rate, true);
                }
            }
        } catch (e) {
            A.Wf('Error on accessing ECB data:', e);
        }
    return A.wait(1);
}

async function scanHPs() {
    for (const pitem of devices)
        if (pitem && pitem.type === 'printer' && !!pitem.enabled) try {
            const idn = pitem.id + '.';
            const below10 = [];
            const body = await A.get('http://' + pitem.ip[0] + '/DevMgmt/ConsumableConfigDyn.xml', 2);
            let result = await xmlParseString(body.trim());
            if (!result) return null;
            result = result.ConsumableConfigDyn ? result.ConsumableConfigDyn : result;
            for (const item of result.ConsumableInfo)
                if (item.ConsumableTypeEnum === 'ink' ||
                    item.ConsumableTypeEnum === 'inkCartridge') {
                    const p = 'P' + item.ConsumableStation,
                        lc = item.ConsumableLabelCode,
                        idnc = idn + 'ink.' + lc,
                        d = item.Installation ? item.Installation.Date : null,
                        l = parseInt(item.ConsumablePercentageLevelRemaining),
                        ci = item.ConsumableIcon,
                        s = ci.Shape,
                        fc = ci.FillColor,
                        n = item.ConsumableSelectibilityNumber;
                    let rgb = fc.Blue | (fc.Green << 8) | (fc.Red << 16);
                    rgb = '#' + (0x1000000 + rgb).toString(16).slice(1);
                    const ss = `${l}%, ${p}=${lc}, ${d ? d + ',' : ''}  ${n}, ${rgb}, ${s}`;
                    if (l <= 10)
                        below10.push(lc);
                    //                A.I(`printer ${idn} = ${below10}`);
                    await A.makeState(idnc, ss);
                    await A.wait(1);
                }
            await A.makeState(idn + 'ink', below10.length > 0 ? below10.join(', ') : 'All >10%', true);
            await A.makeState(pitem.id, '' + A.dateTime(new Date()), true);
        } catch (e) {
            A.Wf("Had error when reaching printer '%s'. Check link address!", pitem.id);
        }
    return A.wait(1);
}


/// @name getUWZ
/// @return Promise
///
async function getUWZ() {
    try {
        const data = await A.get('http://feed.alertspro.meteogroup.com/AlertsPro/AlertsProPollService.php?method=getWarning&language=de&areaID=' + doUwz, 2);
        const wr = data && data.results;
        if (!wr)
            throw new Error('UWZ data err: ' + A.O(data));
        const w = wr.map(i => (lang === 'de' ?
            (longuwz ? i.payload.translationsLongText.DE : i.payload.translationsShortText.DE) :
            (longuwz ? i.payload.longText : i.payload.shortText)) + (longuwz ? ': ' + i.payload.levelName : ''));
        let wt = w.join(numuwz < 0 ? '<br>\n' : '\n');
        wt = wt === '' ? 'No warnings' : wt;
        if (wt !== wlast) {
            wlast = wt;
            A.I(`UWZ found the following (changed) warnings: ${wt}`);
            if (numuwz > 0) {
                for (const x in w)
                    if (x < numuwz) await A.makeState('_UWZ' + x, w[x], true);
                    else break;

                for (let n = w.length; n < numuwz; n++)
                    await A.makeState('_UWZ' + n, '', true);
            } else await A.makeState('_UWZ', wlast, true);
        }
    } catch (e) {
        A.W(`Error in getUWZ: ${e}`);
    }
    return A.wait(1);
}


/// @name setItem
/// Process any scanlist item after lasthere for ipHere or btHere was set to new Date
///
/// @param {item from scanList} item - scanlist entry which found to be here.
async function setItem(item) {
    const wasanw = !!item.anwesend;
    let lasthere = item.lasthere;
    let anw = true;
    const nDel = item.enabled < 0 ? delayAway : item.enabled;
    const idn = item.id;
    const whathere = '' + (item.ipHere ? 'IP' : '') + (item.btHere ? (item.ipHere ? '+BT' : 'BT') : '');
    const here = (item.ipHere && item.btHere) ? (item.btHere > item.ipHere ? item.btHere : item.ipHere) : item.ipHere || item.btHere;
    if (here) {
        item.lasthere = here;
        //        A.I(A.F('item:',item.id,', anw:',anw, ', bht', item.btHere, ', iph: ',item.ipHere,', itemlh:', item.lasthere));
    } else {
        let n = Date.now();
        if (!lasthere)
            lasthere = item.lasthere = new Date(n - (nDel * 1001 * 60));

        n -= lasthere.getTime();
        //                    A.I(A.F('item ',item.name, item.lasthere, d));
        if (n > (nDel * 1000 * 60))
            anw = false;
    }
    //    if (!item.lasthere)
    //        item.lasthere = new Date(Date.now() - (delayAway * 1000 * 60 * 10));
    //    A.I(A.F('item:',item.id,', anw:',anw, ', bht', item.btHere, ', iph: ',item.ipHere,', anwesend', item.anwesend, ', lasthere: ',lasthere, ', itemlh:', item.lasthere));
    if (item.anwesend !== anw || anw !== wasanw || lasthere !== item.lasthere) {
        item.anwesend = anw;
        //        A.I(A.F('lasthere:',item.lasthere, ' locDate:', A.dateTime(item.lasthere),' anwesend:', anw, ' iphere: ',!!item.ipHere, ' bthere:',!!item.btHere))
        await A.makeState(idn + '._lastHere', A.dateTime(item.lasthere), true);
        //        A.makeState(idn + '.lasthere', item.lasthere)
        await A.makeState(item.id, !!anw, true);
        await A.makeState(item.id + '._here', !!anw, true);
        await A.makeState(item.id + '._whatHere', whathere, true);
        //            .then(() => A.makeState(idn + '.here', (item.ipHere ? 'IP ' : '') + (item.btHere ? 'BT' : '')))
        //            .then(() => item.hasIP ? A.makeState(idn + '.ipHere', !!item.ipHere) : false)
        //            .then(() => item.hasBT ? A.makeState(idn + '.btHere', !!item.btHere) : false);
    }
}

/// @name foundIpMac
///
///
/// @param {object} what - object with one or more of {ipAddress, macAddress, by, ... }
/// @returns {void} -
async function foundIpMac(what) {
    let found = false;
    const ip = what.ipAddress && Network.isIP(what.ipAddress) && what.ipAddress.trim().toLowerCase();
    const mac = what.macAddress && Network.isMac(what.macAddress) && what.macAddress.trim().toLowerCase();

    //    if (what.macAddress === 'dc:53:60:e6:e8:94')
    //        debugger;
    if (ip) {
        what.ipAddress = ip;
        const item = ipList[ip];
        if (item) {
            found = true;
            if (knownIPs.indexOf(ip) < 0)
                knownIPs.push(ip);
            if (!item.ipHere) {
                item.ipHere = new Date();
                await setItem(item);
            }
        } else await network.dnsReverse(ip).then(names => what.hosts = names, () => null);

    }

    //    A.Df(`foundIpMac: %s, %s, %j`, ip, mac, found ? ipList[ip] : what);
    if (mac) {
        const item = macList[mac];
        what.getMacVendor = Network.getMacV(mac);
        if (ip)
            network.combine(mac, ip, [...(what.hosts || []), ...(what.hostName && [what.hostName] || [])]);
        //        A.Df('found mac %s of %O: %O', mac, what, item);
        if (item) {
            found = true;
            if (knownIPs.indexOf(mac) < 0)
                knownIPs.push(mac);

            if (ip && knownIPs.indexOf(ip)) {
                knownIPs.push(mac);
                network.combine(mac, ip);
            }
            if (!item.ipHere) {
                item.ipHere = new Date();
                await setItem(item);
            }
        }
    }
    if (!found) {
        if ((ip && knownIPs.indexOf(ip) < 0) && (mac && knownIPs.indexOf(mac) < 0))
            ukIp[ip] = what;
    }
}
/// @name foundBt
///
///
/// @param {object} what - object with one or more of {address, by, ... }
async function foundBt(what) {
    const mac = what.address.toLowerCase().trim(),
        item = btList[mac];
    A.Df('-BtFound %s with %j', item && item.id || 'unknown', what); // REM
    if (item) {
        if (!item.btHere) {
            item.btHere = new Date();
            await setItem(item);
        }
    } else {
        what.btVendor = Network.getMacV(mac);
        if (knownBTs.indexOf(mac) < 0)
            ukBt[mac] = what;
        //        A.D(A.F('bt notf', what));
    }
}

async function scanAll() {

    function makeId(str, name) {
        if (name && Array.isArray(name))
            name = name[0];
        str = name ? name + '_' + str : str;
        return str.replace(/[\][* ,;'"`<>\\?.]/g, '-');
    }

    //    A.D(`New scan stated now.`);
    let whoHere = [];
    let allHere = [];
    let notHere = [];

    const prom = [];
    const btl = scanBt && A.ownKeys(btList).length;
    //    prom.push(btl ? bluetooth.startNoble(scanDelay * 0.8).catch(e => A.W(`noble error: ${A.O(e)}`)) : A.wait(1));
    prom.push(btl ? bluetooth.startScan(A.ownKeys(scansBTs)).catch(e => A.W(`bl scan error: ${A.O(e)}`)) : A.wait(1));
    prom.push(A.wait(1).then(async () => {
        // eslint-disable-next-line no-unused-vars
        for (const [name, item] of Object.entries(scanList))
            if (item.type === 'URL') {
                for (const url of item.ip) {
                    await A.wait(10);
                    await A.get(url.trim(), {
                        method: 'HEAD'
                    })
                        .then(() => setItem(item, (item.ipHere = new Date())), () => null);
                }
            }
        return true;
    }));
    //    prom.push(A.seriesInOI(scanList, item => item.type === 'URL' ? A.get(item.ip.trim()).then(() => setItem(item, (item.ipHere = new Date()))).catch(e => e) : A.resolve(), 1));
    if (A.ownKeys(macList).length + A.ownKeys(ipList).length)

        prom.push(A.wait(1).then(async () => {
            // eslint-disable-next-line no-unused-vars
            if (doArp)
                await network.arpScan(arpcmd);
            else
                await A.wait(1);

            // eslint-disable-next-line no-unused-vars
            for (const [key, it] of Object.entries(scanList))
                if (!it.btHere && !it.ipHere && it.rip && it.rip.length > 0) {
                    //                        A.Df('check unreached %s: %O', it.name, it);
                    const x = await network.ping(it.rip);
                    if (x)
                        for (const i of x)
                            await foundIpMac({
                                ipAddress: i,
                                by: 'ping'
                            });
                }

        }));
    /*             (doArp ? network.arpScan(arpcmd) : A.wait(1))
                .then(() => {
                    return A.seriesInOI(scanList, it => {
                        if (!it.btHere && !it.ipHere && it.rip && it.rip.length > 0) {
                            //                        A.Df('check unreached %s: %O', it.name, it);
                            return A.wait(0).then(() => network.ping(it.rip)).then(x => x ? x.forEach(i => foundIpMac({
                                ipAddress: i,
                                by: 'ping'
                            })) : null).catch(e => A.W(`ping error: ${A.O(e)}`));
                        }
                        return Promise.resolve();
                    }, 1);
                }).catch(e => A.W(`ping error: ${A.O(e)}`)));
     */
    await Promise.all(prom).catch(A.nop);
    await A.wait(5);
    // eslint-disable-next-line no-unused-vars
    for (const [key, item] of Object.entries(scanList)) {
        //            A.D(`Promise all  returned ${res}  ${res}:${A.O(res)}`);
        if (item.type !== 'IP' && item.type !== 'BT' && item.type !== 'URL')
            continue;
        if (!item.enabled)
            continue;
        const nDel = item.enabled < 0 ? delayAway : item.enabled;

        const d = new Date(),
            n = d.getTime();
        if (!item.lasthere)
            item.lasthere = new Date(n - (nDel * 1001 * 60));

        const dd = n - item.lasthere.getTime();
        //                    A.I(A.F('item ',item.name, item.lasthere, d));
        if (dd > (nDel * 1000 * 60))
            item.anwesend = false;
        if (item.anwesend) {
            allHere.push(item.id);
            if (item.name === item.id)
                whoHere.push(item.id);
        } else if (item.name === item.id)
            notHere.push(item.id);

        //            A.I(A.F('item:',item.id,',  anwesend', item.anwesend, ', here: ',item.here, ', dd: ',dd, ', itemlh:', item.lasthere));
        await A.makeState(item.id, !!item.anwesend, true);
        await A.makeState(item.id + '._here', !!item.anwesend, true);
        if (!item.anwesend) item.countHere = 0;
        else item.countHere = (item.countHere || 0) + 1;
        await A.makeState(item.id + '._nHere', item.countHere, true);
        if (!item.anwesend)
            await A.makeState(item.id + '._whatHere', '', true);
        await A.wait(1);
    }
    //            let wh = whoHere.join(', ');
    //            if (oldWhoHere !== wh) {
    //                oldWhoHere = wh;
    //                A.I(`ScanAll: From all ${allhere.length} devices dedected ${countHere} are whoHere: ${wh}`);
    //            }
    await A.makeState('_nHere', whoHere.length, true);
    allHere = allHere.join(', ');
    notHere = notHere.join(', ');
    whoHere = whoHere.join(', ');
    A.D(`radar2 found here (${allHere})`);
    A.D(`and who here (${whoHere})`);
    A.D(`and not here (${notHere})`);
    await A.makeState('_allHere', allHere, true);
    await A.makeState('_notHere', notHere, true);
    await A.makeState('_isHere', whoHere, true);
    const ubt = A.ownKeysSorted(ukBt);
    const uip = A.ownKeysSorted(ukIp);
    A.Df("radar2 found uBT's: %O", ubt);
    A.Df("radar2 found uIP's: %O", uip);
    if (suBt)
        for (const mac of ubt)
            await A.makeState('_uBTs.' + makeId(mac, ukBt[mac].btName), A.f(ukBt[mac]), true);
    ukBt = {};
    await A.makeState('_uBTs', JSON.stringify(ubt), true);

    if (suIp)
        for (const ip of uip)
            await A.makeState('_uIPs.' + makeId(ip, ukIp[ip].hosts), A.f(ukIp[ip]), true);
    await A.makeState('_uIPs', A.O(A.ownKeysSorted(ukIp)), true);
    ukIp = {};

    for (const item in scanList)
        scanList[item].ipHere = scanList[item].btHere = 0;

}

/*
process.on('SIGINT', () => {
    A.W('SIGINT signal received.');
    A.wait(1000).then(() => {
            A.stop(true);
            network.stop();
            bluetooth.stop();
        })
        .then(() => A.wait(2000))
        .then(() => process.exit(0));
});

*/

async function testLinux(name) {
    const res = await A.isLinuxApp(name).catch(() => false);
    return res ? res : false;
}

A.timer = [];

/* process.on('uncaughtException', function(error) {
    errorManagement.handler.handleError(error);
    if(!errorManagement.handler.isTrustedError(error))
    process.exit(1)
   });

 */
process.on('uncaughtException', err => {
    A.W(`Uncaught Exception: ${err.message}`);
});

process.on('unhandledRejection', (reason, promise) => {
    A.W('Unhandled rejection at ', promise, `reason: ${promise.message}`);
});



// eslint-disable-next-line no-unused-vars
async function main(adapter) {

    if (isTesting)
        A.I('adapter in testing mode, no noble and DHCP!');


    network.on('request', items => {
        items.macVendor = Network.getMacV(items.macAddress);
        delete items.type;
        items.by = 'dhcp';
        foundIpMac(items);
        A.Df('found item %s by dhcp: %s, %s, %s', items.hostName, items.ipAddress, items.macAddress, Network.getMacV(items.macAddress));
    });

    network.on('arp-scan', found => foundIpMac({
        ipAddress: found[0],
        macAddress: found[1],
        by: 'arp'
    }));

    network.on('listenState', listen =>
        A.makeState('info.connection', !!listen, true));
    bluetooth.on('found', what => foundBt(what));

    /*     A.unload = async (how) => {
            await network.stop().catch(A.nop);
            await bluetooth.stop().catch(A.nop);
            return A.If("Unload adapter now with %s", how);
        };
     */
    /*
    A.unload = () => {
        network.stop();
        bluetooth.stop();
    };
*/
    let numecb = [],
        numhp = [];

    //    Network.updateMacdb()
    //    A.wait(1)
    //    await Network.updateMacdb();

    if (A.C.debug)
        A.debug = A.C.debug;

    if (!A.C.devices.length) {
        A.W(`No to be scanned devices are configured for host ${A.adapter.host}! Will stop Adapter`);
        return A.stop(true);
    }

    btid = Number(A.C.btadapterid);
    if (isNaN(btid)) {
        A.W(`BT interface number not defined in config, will use '0'`);
        btid = 0;
    }

    scanDelay = A.toInteger(A.C.scandelay);
    scanDelay = 1000 * (scanDelay < 15 ? 15 : scanDelay);

    await bluetooth.init({
        btid: btid,
        scanTime: Math.floor(scanDelay * 0.85),
        doHci: A.C.hcionly || isTesting,
        doL2p: A.C.l2ponly
    });
    //    bluetooth.on('stateChange', (what) => A.D(`Noble state changed: ${what}`));
    await network.init(!isTesting);

    function updatedelaway(delayAway) {
        delayAway = delayAway < 1 ? 1 : delayAway;
        if (Math.floor(scanDelay * 2 / 1000 / 60) > delayAway)
            delayAway = Math.ceil(scanDelay * 2.5 / 1000 / 60);
        return delayAway;
    }

    delayAway = updatedelaway(A.toInteger(A.C.delayaway));

    A.D(`radar2 set to flag items away if they are not seen for ${delayAway} minutes`);

    if (!A.C.printerdelay || parseInt(A.C.printerdelay) < 100)
        A.C.printerdelay = 100;
    printerDelay = parseInt(A.C.printerdelay);

    if (A.C.knownBTs)
        knownBTs = typeof A.C.knownBTs === 'string' ? A.C.knownBTs.toLowerCase().replace(/['[\]\s]/g, '').split(',') : A.C.knownBTs;
    A.D('use known BT list: ' + A.O(knownBTs));

    if (A.C.knownIPs)
        knownIPs = typeof A.C.knownIPs === 'string' ? A.C.knownIPs.replace(/['[\]\s]/g, '').split(',') : A.C.knownIPs;
    A.D('use known IP list: ' + A.O(knownIPs));

    if (!A.C.knownIPs || !A.C.knownIPs.length) {
        arpcmd = "";
    } else {
        arpcmd = ((A.C.arp_scan_cmd && A.C.arp_scan_cmd.length > 0) ?
            A.C.arp_scan_cmd : A.W(`arp-scan cmd line not configured in config! Will use '-lgq --retry=4 --timeout=400'`, '-lgq --retry=4 --timeout=400'));
        if (A.C.arp_scan_cmd.indexOf('--interface') < 0)
            A.I(`arp-scan will use the following interfaces: ` + A.O(network.ip4addrs()));
        if (arpcmd && await testLinux('arp-scan'))
            if (await A.exec('arp-scan --version'))
                doArp = `"${arpcmd}" on ${network.ip4addrs()}`;
            else A.W('Adapter not running as root or iobroker has no sudo right, cannot use arp-scan!');
    }

    A.D(`radar2 set to scan every ${A.C.scandelay} seconds and printers every ${printerDelay} minutes.`);
    suBt = Boolean(A.C.suBT);
    suIp = Boolean(A.C.suIP);
    A.Df("Will '%s' unknown BT devices and will '%s' unknown IP devices!",
        suBt ? 'save' : 'not save',
        suIp ? 'save' : 'not save');
    devices = A.C.devices;
    let x = await testLinux('hcitool');
    if (x) {
        x = await A.exec('hcitool dev').catch(() => '');
        if (x)
            x = x.slice(8).trim();
        if (x) {
            scanBt = !!x;
            A.If('Will try to scan BT devices: %s', x);
        }
    }
    await A.wait(0);
    try {
        // eslint-disable-next-line complexity
        for (const item of devices) {
            if (typeof item.enabled === 'string')
                item.enabled = Number(item.enabled);
            else if (typeof item.enabled !== 'number')
                item.enabled = -1;
            if (isNaN(item.enabled))
                item.enabled = -1;
            if (item.name)
                item.name = item.name.trim().replace(/[\s.]/g, '_');
            if (!item.name || item.name.length < 2) {
                A.Wf("Invalid item name '%s', must be at least 2 letters long!", item.name);
                continue;
            }
            if (item.name === 'Forum' && Array.isArray(item.ip) && item.ip[0] === 'https://forum.iobroker.net' && item.enabled > 0) {
                if (item.enabled === 10) {
                    A.Wf("Disable item '%s' because default and most likely unneeded", item.name);
                    item.enabled = 0;
                } else if (item.enabled < 600) {
                    A.Wf("Item '%s' should not be checked faster than every 600s", item.name);
                    item.enabled = 600;
                }
            }
            if (scanList[item.name]) {
                A.Wf("Double item name '%s', names cannot be used more than once!", item.name);
                continue;
            }
            item.id = item.name.endsWith('-') ? item.name.slice(0, -1) : item.name;
            item.ip = !item.ip ? [] : Array.isArray(item.ip) ? item.ip : item.ip.split(',');
            item.ip = item.ip.map(i => i.trim());
            if (item.ip.length === 1 && !item.ip[0])
                item.ip.splice(0, 1);
            item.type = '';
            item.macs = item.macs ? item.macs : [];
            let mmacs = Array.isArray(item.macs) ? item.macs : item.macs.split(',');
            mmacs = mmacs.map(i => i.trim().toLowerCase());
            if (mmacs.length === 1 && !mmacs[0])
                mmacs.splice(0, 1);
            for (const val of mmacs) {
                const mac = val && (typeof val === 'string') ? val : null;
                if (mac && Network.isMac(mac)) {
                    // A.Df("Found mac %s in device %s", mac, item.name);
                    item.type = 'IP';
                    item.hasMAC = item.hasMAC ? item.hasMAC.concat(mac) : [mac];
                    item.ipVendor = Network.getMacV(mac);
                    if (macList[mac]) A.W(`mac address ${mac} in ${item.name} was used already for another device ${macList[mac].name}, this is forbidden!`);
                    else macList[mac] = item;
                } else if (mac)
                    A.W(`invalid MAC address in ${item.name}: '${val}'`);
            }
            delete item.macs;
            item.bluetooth = item.bluetooth ? item.bluetooth : [];
            if (!Array.isArray(item.bluetooth))
                item.bluetooth = item.bluetooth.split(',');
            item.bluetooth = item.bluetooth.map(x => x.trim().toLowerCase());
            if (item.bluetooth.length === 1 && !item.bluetooth[0])
                item.bluetooth.splice(0, 1);
            for (let b of item.bluetooth) {
                const le = b.startsWith('!');
                if (le)
                    b = b.slice(1).trim();
                if (Network.isMac(b)) {
                    if (!le)
                        scansBTs[b] = item;
                    if (btList[b] && btList[b] !== item) {
                        A.W(`bluetooth address ${b} in ${item.name} was used already for another device ${btList[b].name}, this is forbidden!`);
                    } else {
                        btList[b] = item;
                        item.type = 'BT';
                        item.btVendor = Network.getMacV(b);
                    }
                } else if (b !== '')
                    A.W(`Invalid bluetooth address '${b}' in ${item.name} , 6 hex numbers separated by ':'`);
            }
            if (item.ip.length && item.name.startsWith('HP-')) {
                item.type = 'printer';
                numhp = numhp.concat(item.name);
            } else if (item.ip.length && item.name.startsWith('ECB-')) {
                item.type = 'ECB';
                numecb = numecb.concat(item.ip);
            } else if (item.ip.length && item.ip[0].startsWith('http')) {
                item.type = 'URL';
            } else if (item.ip.length) {
                if (item.type !== 'BT')
                    item.type = 'IP';
                item.rip = !item.rip ? [] : !Array.isArray(item.rip) ? [item.rip] : item.rip;
                for (const addr of item.ip)
                    if (Network.isIP(addr)) {
                        if (item.rip.indexOf(addr) < 0)
                            item.rip.push(addr);
                    } else {
                        const res = await network.dnsResolve(addr);
                        if (res)
                            for (const i of res)
                                if (item.rip.indexOf(i) < 0) item.rip.push(i);
                    }
                item.rip.forEach((ip) => ipList[ip] && ipList[ip] !== item ?
                    A.W(`ip address ${ip} in ${item.name} was used already for another device ${ipList[ip].name}, this is forbidden!`) :
                    (ipList[ip] = item));
                for (const ip of item.rip) {
                    const x = await network.ping(ip).catch(A.nop).then(() => Network.getMac(ip));
                    if (x)
                    // if (macList[x] && macList[x] !== item)
                    //     A.W(`mac address '${x}' was used already for another device ${macList[x].name}`);
                    // else
                    {
                        if (item.hasMAC) {
                            //                                            A.If('mac for %O is %O', item, item.hasMAC);
                            if (item.hasMAC.indexOf(x) < 0)
                                item.hasMAC.push(x);
                        } else item.hasMAC = [x];
                        if (x && ip)
                            network.combine(x, ip);
                        //                    A.I(A.F('ip %s has mac %s.',ip,x));
                        //                                        A.Df('add mac %s for ip %s in %s to %O and vendor: ', x, ip, item.name, item.hasMAC, item.mipVendor);
                        macList[x] = item;
                    }
                }
                delete item.ip;
            } else if (!item.type) {
                A.W(`Invalid Device '${item.name}' should have IP or BT set!`);
                continue;
            }
            scanList[item.name] = item;
            const st = await A.myGetState(item.id + '._lastHere');
            if (st && st.ts)
                await A.makeState(item.id + '._lastHere', A.dateTime(item.lasthere = new Date(st.ts)), true);
            await A.extendObject(item.id, {
                type: 'state',
                native: {
                    radar2: item
                }
            }).catch(A.pE);
            A.I(`Init item ${item.name} with ${A.O(A.removeEmpty(item))}`);
            await A.wait(1);
        }
        if (parseInt(A.C.external) > 0)
            await scanExtIP();

        A.I(`Adapter identified macs: (${A.ownKeys(macList)}), \nips: (${A.ownKeys(ipList)}), \nbts LE: (${A.ownKeys(btList)}), \nbts norm: (${A.ownKeys(scansBTs)})`);
        // const res = await A.getObjectList({
        //     include_docs: true
        // });
        // const r = {};
        // res.rows.map(i => r[i.doc._id] = i.doc);
        if (!A.C.delayuwz || parseInt(A.C.delayuwz) <= 0)
            A.I(`No UWZ warning because of Delay is ${A.C.delayuwz}`);
        else {
            delayuwz = parseInt(A.C.delayuwz);
            numuwz = parseInt(A.C.numuwz);
            longuwz = Boolean(A.C.longuwz);
            lang = A.C.lang;
            if (A.C.latitude && A.C.longitude) {
                const res = await A.get(`http://feed.alertspro.meteogroup.com/AlertsPro/AlertsProPollService.php?method=lookupCoord&lat=${A.C.latitude}&lon=${A.C.longitude}`, 2)
                    .catch(e => A.W(`Culd not get UWZ Area ID: ${e} for Laenge: ${A.C.longitude} Breite: ${A.C.latitude}`, null));
                doUwz = res && res[0] && res[0].AREA_ID;
                if (doUwz && delayuwz > 0) {
                    A.I(`will scan UWZ with code ${doUwz} every ${delayuwz} minutes`);
                    A.timer.push(setInterval(getUWZ, delayuwz * 1000 * 60));
                    await getUWZ();
                }
            } else A.W('No geo location data found configured in admin to calculate UWZ AREA ID or ID not valid!');
        }
        if (numecb.length && parseInt(A.C.external) > 0) {
            A.I(A.F('Will scan ECB for ', numecb, ' every ', A.C.external, ' minutes'));
            A.timer.push(setInterval(scanECBs, parseInt(A.C.external) * 1000 * 60));
            await scanECBs().catch(A.nop);
        }
        if (numhp.length && printerDelay > 0) {
            A.I(A.F('will scan printers ', numhp, ' every ', printerDelay, ' minutes'));
            A.timer.push(setInterval(scanHPs, printerDelay * 1000 * 60));
            await scanHPs();
        }

        A.I(`radar2 found ${Object.keys(scanList).length} devices in config (${Object.keys(scanList)}) and ${Object.entries(scanList).filter(i => !!i[1].enabled).length} enabled.`);
        A.I(`radar2 set use of noble(${!!bluetooth.hasNoble}), doArp(${doArp}), btid(${btid}) and doUwz(${doUwz},${delayuwz},${numuwz},${lang},${longuwz}).`);
        const ms = await A.Ptime(scanAll());
        A.I(`first scan took ${ms/1000} seconds`);
        if (scanDelay <= ms) {
            scanDelay = A.toInteger(ms + 2000);
            delayAway = updatedelaway(delayAway);
            A.W(`scanDelay increased to ${scanDelay/1000} seconds, delayAway to ${delayAway} minutes!`);
        }
        A.timer.push(setInterval(scanAll, scanDelay));
        if (parseInt(A.C.external) > 0) {
            A.I(A.F('will scan external network every ', A.C.external, ' minutes'));
            A.timer.push(setInterval(scanExtIP, parseInt(A.C.external) * 1000 * 60));
            await scanExtIP();
        }
        // scan first time and generate states if they do not exist yet

        await A.cleanup('*', A.D('cleanup old states...')); // clean up old states not created this time!
        A.I('Adapter initialization finished!');
    } catch (err) {
        A.W(`radar initialization finished with error ${A.O(err)}, will stop adapter!`);
        A.stop(1);
    }
}
