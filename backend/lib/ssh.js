import { Client } from 'ssh2';

// ponytail: interactive SSH session handling unprivileged -> enable (#) escalation and paging disable
export function runSshSession(host, options = {}, commands = []) {
  return new Promise((resolve, reject) => {
    const {
      username = 'admin',
      password = '',
      enablePassword = '',
      port = 22,
      timeout = 30000
    } = options;

    const conn = new Client();
    let timeoutId = setTimeout(() => {
      conn.end();
      reject(new Error(`SSH connection timeout to ${host}:${port}`));
    }, timeout);

    conn.on('ready', () => {
      conn.shell({ term: 'vt100', cols: 300, rows: 200 }, (err, stream) => {
        if (err) {
          clearTimeout(timeoutId);
          conn.end();
          return reject(err);
        }

        let fullOutput = '';
        let currentBuffer = '';
        let step = 'START'; // 'START' -> 'ENABLE_SENT' -> 'PRIVILEGED' -> 'RUNNING' -> 'DONE'
        let commandIndex = 0;
        let commandTimer = null;
        let commandStallTimer = null;

        const writeLine = (text) => {
          if (stream.writable) stream.write(`${text}\n`);
        };

        const executeNextCommand = () => {
          clearTimeout(commandStallTimer);

          if (commandIndex >= commands.length) {
            step = 'DONE';
            writeLine('exit');
            setTimeout(() => {
              clearTimeout(timeoutId);
              conn.end();
              resolve(fullOutput);
            }, 800);
            return;
          }

          const cmd = commands[commandIndex++];
          writeLine(cmd);

          // Fallback timer if prompt isn't detected for this command after 3.5s
          commandStallTimer = setTimeout(() => {
            if (step === 'RUNNING') {
              executeNextCommand();
            }
          }, 3500);
        };

        stream.on('data', (chunk) => {
          const str = chunk.toString();
          fullOutput += str;
          currentBuffer += str;

          // 1. Switch prompt asks for enable password
          if (/[Pp]assword:\s*$/.test(currentBuffer.trim())) {
            currentBuffer = '';
            writeLine(enablePassword || password);
            return;
          }

          // 2. Unprivileged user prompt: Switch>
          if (step === 'START' && />\s*$/.test(currentBuffer.trim())) {
            step = 'ENABLE_SENT';
            currentBuffer = '';
            writeLine('enable');
            return;
          }

          // 3. Privileged prompt reached: Switch#
          if ((step === 'START' || step === 'ENABLE_SENT') && /#\s*$/.test(currentBuffer.trim())) {
            step = 'PRIVILEGED';
            currentBuffer = '';
            writeLine('terminal length 0');
            setTimeout(() => {
              step = 'RUNNING';
              executeNextCommand();
            }, 400);
            return;
          }

          // 4. In running mode and see prompt #
          if (step === 'RUNNING' && /#\s*$/.test(currentBuffer.trim())) {
            currentBuffer = '';
            clearTimeout(commandTimer);
            commandTimer = setTimeout(() => {
              executeNextCommand();
            }, 300);
          }
        });

        stream.on('close', () => {
          clearTimeout(timeoutId);
          clearTimeout(commandTimer);
          clearTimeout(commandStallTimer);
          conn.end();
          resolve(fullOutput);
        });

        // Safety fallback timer if initial prompt wasn't seen in 1.5s
        setTimeout(() => {
          if (step === 'START') {
            writeLine('enable');
            setTimeout(() => {
              if (step === 'START' || step === 'ENABLE_SENT') {
                writeLine(enablePassword || password);
                writeLine('terminal length 0');
                step = 'RUNNING';
                executeNextCommand();
              }
            }, 1000);
          }
        }, 1500);
      });
    });

    conn.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });

    conn.connect({
      host,
      port,
      username,
      password,
      readyTimeout: timeout,
      algorithms: {
        kex: [
          'diffie-hellman-group14-sha1',
          'diffie-hellman-group1-sha1',
          'diffie-hellman-group-exchange-sha1',
          'diffie-hellman-group-exchange-sha256',
          'ecdh-sha2-nistp256',
          'ecdh-sha2-nistp384',
          'ecdh-sha2-nistp521'
        ],
        cipher: [
          'aes128-ctr',
          'aes192-ctr',
          'aes256-ctr',
          'aes128-cbc',
          '3des-cbc',
          'aes256-cbc'
        ]
      }
    });
  });
}
