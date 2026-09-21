const os = require('os');
const pty = require('node-pty');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

console.log("Servidor WebSocket rodando na porta " + PORT);

wss.on('connection', (ws) => {
    console.log("Novo cliente conectado!");

    const shell = os.platform() === 'win32' ? 'powershell.exe' : (process.env.SHELL || 'bash');

    let ptyProcess;
    try {
        ptyProcess = pty.spawn(shell, [], {
            name: 'xterm-color',
            cols: 80,
            rows: 24,
            cwd: process.env.HOME || '/root',
            env: process.env
        });
    } catch (err) {
        console.error("Erro ao iniciar o PTY:", err);
        ws.send("\r\nErro ao iniciar o terminal no servidor.\r\n");
        ws.close();
        return;
    }

    // LER DO TERMINAL -> ENVIAR PARA O FRONTEND
    ptyProcess.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(data);
        }
    });

    // LER DO FRONTEND -> ENVIAR PARA O TERMINAL
    ws.on('message', (message) => {
        ptyProcess.write(message.toString());
    });

    // TRATAR ENCERRAMENTO DO PROCESSO DO TERMINAL
    ptyProcess.onExit(({ exitCode }) => {
        console.log(`Processo PTY encerrou com código ${exitCode}`);
        if (ws.readyState === WebSocket.OPEN) {
            ws.close();
        }
    });

    // LIMPEZA QUANDO O USUÁRIO FECHAR A ABA OU DESCONECTAR
    ws.on('close', () => {
        console.log("Cliente desconectado. Encerrando o processo PTY...");
        try {
            ptyProcess.kill();
        } catch (e) {
            // Ignora se já estiver morto
        }
    });
});
