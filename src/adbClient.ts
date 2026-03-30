import { exec, ChildProcess } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as vscode from 'vscode';

const execAsync = promisify(exec);

/**
 * Represents a connected Android device.
 */
export interface ConnectedDevice {
    id: string;
    type: string; // 'device' | 'offline' | 'unauthorized'
    model?: string;
    product?: string;
    transportId?: string;
    connectionType: 'wired' | 'wireless';
}

/**
 * Client for interacting with the Android Debug Bridge (ADB).
 */
export class AdbClient {
    private adbPath: string;
    private logcatChannel?: vscode.OutputChannel;
    private logcatProcess?: ChildProcess;
    private logcatDeviceId?: string;
    private logcatPackageName?: string;
    private logcatPidRefreshTimer?: NodeJS.Timeout;

    constructor(private outputChannel: vscode.OutputChannel) {
        const config = vscode.workspace.getConfiguration('adb');
        this.adbPath = config.get<string>('path') || 'adb';
    }

    /**
     * Kills gvfsd-mtp/gvfsd-gphoto2 on Linux to prevent PTP/MTP conflicts
     * that cause Nautilus (GNOME Files) to hang or crash.
     */
    public async killConflictingMtpServices(): Promise<void> {
        if (os.platform() !== 'linux') { return; }
        try {
            await execAsync('killall gvfsd-mtp gvfsd-gphoto2 2>/dev/null');
        } catch {
            // Processes not running — nothing to kill
        }
    }

    private async execute(command: string): Promise<string> {
        const fullCommand = `"${this.adbPath}" ${command}`;
        const config = vscode.workspace.getConfiguration('adb');
        const debug = config.get<boolean>('debug') || false;

        if (debug) {
            this.outputChannel.appendLine(`> ${fullCommand}`);
        }
        try {
            const { stdout, stderr } = await execAsync(fullCommand);
            if (debug && stdout) {
                this.outputChannel.appendLine(stdout);
            }
            if (stderr) {
                // Always log stderr if it's not empty, or maybe only on debug? 
                // ADB often prints non-error info to stderr (like file transfer progress), 
                // so let's respect the debug flag for generic stderr too, unless it throws.
                if (debug) {
                    this.outputChannel.appendLine(`stderr: ${stderr}`);
                }
            }
            return stdout.trim();
        } catch (error: any) {
            if (debug) {
                this.outputChannel.appendLine(`Error: ${error.message}`);
            }
            // this.outputChannel.show(true); // Don't auto-open output panel on error
            throw new Error(`ADB Error: ${error.message}`);
        }
    }

    /**
     * Retrieves a list of connected devices.
     * @returns A promise that resolves to an array of ConnectedDevice objects.
     */
    async getConnectedDevices(): Promise<ConnectedDevice[]> {
        const output = await this.execute('devices -l');
        const lines = output.split('\n').slice(1); // Skip first line "List of devices attached"
        return lines
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .map(line => {
                // Parse line: "emulator-5554 device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emulator64_arm64 transport_id:1"
                // or "192.168.1.5:5555 device product:bramble model:Pixel_4a__5G_ device:bramble transport_id:2"
                const parts = line.split(/\s+/);
                const id = parts[0];
                const type = parts[1];

                let model: string | undefined;
                let product: string | undefined;
                let transportId: string | undefined;

                for (let i = 2; i < parts.length; i++) {
                    const part = parts[i];
                    if (part.startsWith('model:')) {
                        model = part.substring(6);
                    } else if (part.startsWith('product:')) {
                        product = part.substring(8);
                    } else if (part.startsWith('transport_id:')) {
                        transportId = part.substring(13);
                    }
                }

                // Determine connection type
                // IP address pattern: digits.digits.digits.digits:digits
                const isIpAddress = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/.test(id);
                const connectionType = isIpAddress ? 'wireless' : 'wired';

                return {
                    id,
                    type,
                    model,
                    product,
                    transportId,
                    connectionType
                };
            });
    }

    async connectToDevice(ip: string): Promise<string> {
        return this.execute(`connect ${ip}`);
    }

    async disconnectDevice(deviceId: string): Promise<string> {
        return this.execute(`disconnect ${deviceId}`);
    }

    async installApk(deviceId: string, apkPath: string): Promise<string> {
        return this.execute(`-s ${deviceId} install -r "${apkPath}"`);
    }

    private findAapt2(): string | undefined {
        const { execSync } = require('child_process');
        // Try aapt2 in PATH first
        try {
            execSync('aapt2 version', { encoding: 'utf8', timeout: 3000 });
            return 'aapt2';
        } catch {}
        // Search in known SDK locations
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const home = os.homedir();
        const sdkRoots = [
            process.env.ANDROID_HOME,
            process.env.ANDROID_SDK_ROOT,
            path.join(home, 'Android', 'Sdk'),
            path.join(home, 'Library', 'Android', 'sdk'),
        ];
        // Also search Unity SDK locations
        const unityHub = path.join(home, 'Unity', 'Hub', 'Editor');
        try {
            for (const ver of fs.readdirSync(unityHub)) {
                sdkRoots.push(path.join(unityHub, ver, 'Editor', 'Data', 'PlaybackEngines', 'AndroidPlayer', 'SDK'));
            }
        } catch {}
        for (const sdk of sdkRoots) {
            if (!sdk) { continue; }
            const buildToolsDir = path.join(sdk, 'build-tools');
            try {
                const versions = fs.readdirSync(buildToolsDir).sort().reverse();
                for (const ver of versions) {
                    const aapt2Path = path.join(buildToolsDir, ver, 'aapt2');
                    if (fs.existsSync(aapt2Path)) {
                        return aapt2Path;
                    }
                }
            } catch {}
        }
        return undefined;
    }

    getApkInfo(apkPath: string): {packageName: string; versionName: string; versionCode: string} | undefined {
        const aapt2 = this.findAapt2();
        if (!aapt2) { return undefined; }
        try {
            const { execSync } = require('child_process');
            const output = execSync(`"${aapt2}" dump badging "${apkPath}"`, { encoding: 'utf8', timeout: 5000 });
            const packageMatch = output.match(/package:\s+name='([^']+)'/);
            const versionNameMatch = output.match(/versionName='([^']+)'/);
            const versionCodeMatch = output.match(/versionCode='([^']+)'/);
            if (packageMatch) {
                return {
                    packageName: packageMatch[1],
                    versionName: versionNameMatch?.[1] ?? 'unknown',
                    versionCode: versionCodeMatch?.[1] ?? 'unknown'
                };
            }
        } catch {}
        return undefined;
    }

    async uninstallApp(deviceId: string, packageName: string): Promise<string> {
        return this.execute(`-s ${deviceId} uninstall ${packageName}`);
    }

    async clearAppData(deviceId: string, packageName: string): Promise<string> {
        return this.execute(`-s ${deviceId} shell pm clear ${packageName}`);
    }

    async killApp(deviceId: string, packageName: string): Promise<string> {
        return this.execute(`-s ${deviceId} shell am force-stop ${packageName}`);
    }

    async restartServer(): Promise<string> {
        await this.killConflictingMtpServices();
        await this.execute('kill-server');
        return this.execute('start-server');
    }

    async executeShellCommand(deviceId: string, command: string): Promise<string> {
        return this.execute(`-s ${deviceId} shell ${command}`);
    }

    async toggleWifi(deviceId: string, enable: boolean): Promise<string> {
        const state = enable ? 'enable' : 'disable';
        return this.execute(`-s ${deviceId} shell svc wifi ${state}`);
    }

    async toggleMobileData(deviceId: string, enable: boolean): Promise<string> {
        const state = enable ? 'enable' : 'disable';
        return this.execute(`-s ${deviceId} shell svc data ${state}`);
    }

    async toggleAirplaneMode(deviceId: string, enable: boolean): Promise<string> {
        const state = enable ? '1' : '0';
        // Try to set global setting and broadcast intent
        await this.execute(`-s ${deviceId} shell settings put global airplane_mode_on ${state}`);
        return this.execute(`-s ${deviceId} shell am broadcast -a android.intent.action.AIRPLANE_MODE --ez state ${enable}`);
    }

    async setAppPermission(deviceId: string, packageName: string, permission: string, grant: boolean): Promise<string> {
        const action = grant ? 'grant' : 'revoke';
        return this.execute(`-s ${deviceId} shell pm ${action} ${packageName} ${permission}`);
    }

    async takeScreenshot(deviceId: string, localPath: string): Promise<string> {
        // Capture to device temp file
        const remotePath = '/sdcard/screenshot.png';
        await this.execute(`-s ${deviceId} shell screencap -p ${remotePath}`);
        // Pull to local path
        await this.execute(`-s ${deviceId} pull ${remotePath} "${localPath}"`);
        // Clean up remote file
        await this.execute(`-s ${deviceId} shell rm ${remotePath}`);
        return localPath;
    }

    /**
     * Gets the Process ID (PID) for a given package name.
     * @param deviceId The ID of the target device.
     * @param packageName The package name to look up.
     * @returns The PID as a string, or undefined if not found.
     */
    public async getPidForPackage(deviceId: string, packageName: string): Promise<string | undefined> {
        try {
            // pidof might return multiple PIDs, we take the first one
            const output = await this.execute(`-s ${deviceId} shell pidof ${packageName}`);
            return output.trim().split(/\s+/)[0];
        } catch (e) {
            return undefined;
        }
    }

    /**
     * Starts a Logcat session for the device.
     * @param deviceId The ID of the target device.
     * @param pid Optional PID to filter logs by process.
     * @param level Optional log level to filter by (V, D, I, W, E, F).
     */
    private getLogcatChannel(): vscode.OutputChannel {
        if (!this.logcatChannel) {
            this.logcatChannel = vscode.window.createOutputChannel('ADB Logcat', 'logcat');
        }
        return this.logcatChannel;
    }

    public stopLogcat(): void {
        if (this.logcatPidRefreshTimer) {
            clearInterval(this.logcatPidRefreshTimer);
            this.logcatPidRefreshTimer = undefined;
        }
        if (this.logcatProcess) {
            this.logcatProcess.kill();
            this.logcatProcess = undefined;
        }
    }

    public async getLogcat(deviceId: string, packageName?: string, level?: string): Promise<void> {
        this.stopLogcat();

        const channel = this.getLogcatChannel();
        channel.clear();
        channel.show();

        const label = [
            level ? `Level: ${level}` : 'Level: All',
            packageName ? `App: ${packageName}` : null
        ].filter(Boolean).join(', ');
        channel.appendLine(`Starting Logcat for device ${deviceId}... [${label}]`);

        this.logcatDeviceId = deviceId;
        this.logcatPackageName = packageName;

        // Run logcat WITHOUT --pid so we can dynamically track PID changes
        const args = ['-s', deviceId, 'logcat', '-v', 'time'];
        if (level) {
            args.push(`*:${level}`);
        }

        // Resolve PID for package filtering
        let currentPid: string | undefined;
        if (packageName) {
            currentPid = await this.getPidForPackage(deviceId, packageName).catch(() => undefined);
            if (currentPid) {
                channel.appendLine(`Filtering by PID: ${currentPid}`);
            } else {
                channel.appendLine(`App not running yet, waiting...`);
            }

            // Periodically refresh PID (app may restart)
            this.logcatPidRefreshTimer = setInterval(async () => {
                const newPid = await this.getPidForPackage(deviceId, packageName).catch(() => undefined);
                if (newPid && newPid !== currentPid) {
                    currentPid = newPid;
                    channel.appendLine(`--- App restarted, new PID: ${currentPid} ---`);
                } else if (!newPid && currentPid) {
                    currentPid = undefined;
                    channel.appendLine(`--- App stopped ---`);
                }
            }, 2000);
        }

        const { spawn } = require('child_process');
        const child = spawn(this.adbPath, args);
        this.logcatProcess = child;

        let lineBuffer = '';
        child.stdout.on('data', (data: any) => {
            if (!packageName) {
                channel.append(data.toString());
                return;
            }
            // Filter by PID, handling partial lines
            lineBuffer += data.toString();
            const lines = lineBuffer.split('\n');
            lineBuffer = lines.pop() || '';
            for (const line of lines) {
                if (!currentPid || line.match(new RegExp(`\\(\\s*${currentPid}\\)`))) {
                    channel.appendLine(line);
                }
            }
        });

        child.stderr.on('data', (data: any) => {
            channel.append(data.toString());
        });

        child.on('close', (code: any) => {
            channel.appendLine(`Logcat process exited with code ${code}`);
            if (this.logcatProcess === child) {
                this.logcatProcess = undefined;
            }
            if (this.logcatPidRefreshTimer) {
                clearInterval(this.logcatPidRefreshTimer);
                this.logcatPidRefreshTimer = undefined;
            }
        });
    }

    public async getInstalledPackages(deviceId: string): Promise<string[]> {
        const output = await this.execute(`-s ${deviceId} shell pm list packages -3`);
        return output
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.startsWith('package:'))
            .map(line => line.replace('package:', ''))
            .sort();
    }

    /**
     * Retrieves the requested permissions for a package and their granted status.
     * @param deviceId The ID of the target device.
     * @param packageName The package name.
     * @returns A promise that resolves to an array of permission objects.
     */
    public async getAppPermissions(deviceId: string, packageName: string): Promise<{ name: string; granted: boolean }[]> {
        try {
            const output = await this.execute(`-s ${deviceId} shell dumpsys package ${packageName}`);
            const lines = output.split('\n');
            const permissions: { name: string; granted: boolean }[] = [];
            let inPermissionsSection = false;

            for (const line of lines) {
                const trimmed = line.trim();

                // Look for the "runtime permissions:" section
                if (trimmed.startsWith('runtime permissions:')) {
                    inPermissionsSection = true;
                    continue;
                }

                // If we hit another section (usually starts with something like "sharedUser" or unindented text), stop
                if (inPermissionsSection && !line.startsWith('    ')) { // Permissions are indented
                    // Simple heuristic: if indentation drops, we might be out of the section.
                    // However, dumpsys output can be complex. 
                    // "runtime permissions:" block usually ends when indentation decreases or a new block starts.
                    // Let's assume if it doesn't match the permission pattern, we might be done or it's a continuation.
                }

                if (inPermissionsSection) {
                    // Line format: "android.permission.CAMERA: granted=true"
                    const match = trimmed.match(/^([^:]+):\s*granted=(true|false)/);
                    if (match) {
                        permissions.push({
                            name: match[1],
                            granted: match[2] === 'true'
                        });
                    } else if (trimmed === "") {
                        // Empty line might mean end of section
                        inPermissionsSection = false;
                    }
                }
            }
            return permissions.sort((a, b) => a.name.localeCompare(b.name));
        } catch (e) {
            // console.error('Failed to get app permissions', e);
            return [];
        }
    }

    async startApp(deviceId: string, packageName: string): Promise<string> {
        // Using monkey to start the app is a common trick to avoid needing the main activity name
        return this.execute(`-s ${deviceId} shell monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`);
    }
}
