"use strict";

const MA = require('./myAdapter'),
    A = MA.MyAdapter,
    Network = require('./myNetwork').Network,
    Bluetooth = require('./myNetwork').Bluetooth;


let network = new Network(false);
network.on('arp-scan', (found) => A.I(found));
A.debug = true;

let bluetooth = new Bluetooth();
bluetooth.on('found', (arg) => A.I(`${arg.by} Scan found ${A.F(arg)}`));
bluetooth.init();

bluetooth.listPairedDevices().then((x) => A.I(A.F('Paired Devices:', x))).then(() => {
/*
    const address = 'C0:97:27:10:B8:65';
    if (bluetooth.device) bluetooth.device.findSerialPortChannel(address, function (channel) {
        A.I(A.F('Found RFCOMM channel for serial port on ', address, channel));

        // make bluetooth connect to remote device
        if (channel >= 0)
            bluetooth.nbt.connect(address, channel, function (err, connection) {
                if (err) return A.E(err);
                connection.write(new Buffer('Hello!', 'utf-8'), () => {
                    A.I("wrote Hello!");
                });
            });

    });
    */
});

function stopAll() {
    if (network) {
        network.stop();
        network = null;
    }
    if (bluetooth) {
        bluetooth.stop();
        bluetooth = null;
    }
}

//network.arpScan('-qlg --retry=3');
network.on('request', (req) => network.dnsReverse(req[3]).then((names) => console.log(`Request  ${req}= from ${network.getMacVendor(req[2])}, ${names}`)));
network.init(true, null, '.fritz.box');
//A.I(A.F(network.iflist));
process.on('SIGINT', () => {
    A.W('SIGINT signal received.');
    stopAll();
    process.exit(0);
});
network.ping(['::1', '::2', '192.168.178.1', '192.168.178.67', 'XS1', 'XS2', '192.168.179.20'], x => console.log(`Ping returned ${x}`))
//    .then(() => network.arpScan('-qlg --retry=3 --timeout=400'))
    .then(() => network.dnsReverse(`192.168.178.67`).then(x => A.I(x)))
    .then(() => network.dnsResolve('fritz.box').then(x => A.I(x)))
//    .then(() => network.dnsReverse('192.168.178.199').then(x => A.I(x)))
    .then(() => Promise.all([bluetooth.startScan(), bluetooth.startNoble(10000)]))
//    .then(() => bluetooth.startScan())
//    .then(found => A.I(A.F('scan found:', found)))
//    .then(() => bluetooth.startNoble(20000))
//    .then(() => A.wait(10000))
    //    .then(() => A.I(A.F(network.ips, network.macs)))
    .catch(err => A.E(err))
    .then(() => A.I('Will stop All now',stopAll()));