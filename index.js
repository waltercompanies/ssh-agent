const core = require('@actions/core');
const child_process = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const { homePath, sshAgentCmdDefault, sshAddCmdDefault, gitCmdDefault } = require('./paths.js');

try {
    const privateKey = core.getInput('ssh-private-key');
    const logPublicKey = core.getBooleanInput('log-public-key', {default: true});

    const sshAgentCmdInput = core.getInput('ssh-agent-cmd');
    const sshAddCmdInput = core.getInput('ssh-add-cmd');
    const gitCmdInput = core.getInput('git-cmd');

    const sshAgentCmd = sshAgentCmdInput ? sshAgentCmdInput : sshAgentCmdDefault;
    const sshAddCmd = sshAddCmdInput ? sshAddCmdInput : sshAddCmdDefault;
    const gitCmd = gitCmdInput ? gitCmdInput : gitCmdDefault;

    if (!privateKey) {
        core.setFailed("The ssh-private-key argument is empty. Maybe the secret has not been configured, or you are using a wrong secret name in your workflow file.");

        return;
    }

    const homeSsh = homePath + '/.ssh';

    console.log(`Adding GitHub.com keys to ${homeSsh}/known_hosts`);

    fs.mkdirSync(homeSsh, { recursive: true });
    fs.appendFileSync(`${homeSsh}/known_hosts`, '\ngithub.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=\n');
    fs.appendFileSync(`${homeSsh}/known_hosts`, '\ngithub.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n');
    fs.appendFileSync(`${homeSsh}/known_hosts`, '\ngithub.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=\n');

    console.log("Starting ssh-agent");

    const authSock = core.getInput('ssh-auth-sock');
    const sshAgentArgs = (authSock && authSock.length > 0) ? ['-a', authSock] : [];

    // Extract auth socket path and agent pid and set them as job variables
    child_process.execFileSync(sshAgentCmd, sshAgentArgs).toString().split("\n").forEach(function(line) {
        const matches = /^(SSH_AUTH_SOCK|SSH_AGENT_PID)=(.*); export \1/.exec(line);

        if (matches && matches.length > 0) {
            // This will also set process.env accordingly, so changes take effect for this script
            core.exportVariable(matches[1], matches[2])
            console.log(`${matches[1]}=${matches[2]}`);
        }
    });

    console.log("Adding private key(s) to agent");

    privateKey.split(/(?=-----BEGIN)/).forEach(function(key) {
        child_process.execFileSync(sshAddCmd, ['-'], { input: key.trim() + "\n" });
    });

    console.log("Key(s) added:");

    child_process.execFileSync(sshAddCmd, ['-l'], { stdio: 'inherit' });

    console.log('Configuring deployment key(s)');

    child_process.execFileSync(sshAddCmd, ['-L']).toString().trim().split(/\r?\n/).forEach(function(key) {
        const parts = key.match(/\bgithub\.com[:/]([_.a-z0-9-]+\/[_.a-z0-9-]+)/i);

        if (!parts) {
            if (logPublicKey) {
              console.log(`Comment for (public) key '${key}' does not match GitHub URL pattern. Not treating it as a GitHub deploy key.`);
            }
            return;
        }

        const sha256 = crypto.createHash('sha256').update(key).digest('hex');
        const ownerAndRepo = parts[1].replace(/\.git$/, '');

        fs.writeFileSync(`${homeSsh}/key-${sha256}`, key + "\n", { mode: '600' });

        child_process.execSync(`${gitCmd} config --global --replace-all url."git@key-${sha256}.github.com:${ownerAndRepo}".insteadOf "https://github.com/${ownerAndRepo}"`);
        child_process.execSync(`${gitCmd} config --global --add url."git@key-${sha256}.github.com:${ownerAndRepo}".insteadOf "git@github.com:${ownerAndRepo}"`);
        child_process.execSync(`${gitCmd} config --global --add url."git@key-${sha256}.github.com:${ownerAndRepo}".insteadOf "ssh://git@github.com/${ownerAndRepo}"`);

        const sshConfig = `\nHost key-${sha256}.github.com\n`
                              + `    HostName github.com\n`
                              + `    IdentityFile ${homeSsh}/key-${sha256}\n`
                              + `    IdentitiesOnly yes\n`;

        fs.appendFileSync(`${homeSsh}/config`, sshConfig);

        console.log(`Added deploy-key mapping: Use identity '${homeSsh}/key-${sha256}' for GitHub repository ${ownerAndRepo}`);
    });

} catch (error) {

    if (error.code == 'ENOENT') {
        console.log(`The '${error.path}' executable could not be found. Please make sure it is on your PATH and/or the necessary packages are installed.`);
        console.log(`PATH is set to: ${process.env.PATH}`);
    }

    core.setFailed(error.message);
}
