const os = require('os');
const pty = require('node-pty');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

console.log("Servidor WebSocket rodando na porta " + PORT);

wss.on('connection', (ws) => {
    console.log("Novo cliente conectado!");

    // Define o shell
    const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';

    // Cria o pseudo-terminal (PTY)
    const ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-color',
        cols: 80,
        rows: 24,
        cwd: process.env.HOME || '/root',
        env: process.env
    });

    // 1. LER DO TERMINAL -> ENVIAR PARA O FRONTEND
    ptyProcess.onData((data) => {
        ws.send(data);
    });

    // 2. LER DO FRONTEND -> ENVIAR PARA O TERMINAL
    ws.on('message', (message) => {
        ptyProcess.write(message.toString());
    });

    // 3. LIMPEZA QUANDO O USUÁRIO FECHAR A ABA
    ws.on('close', () => {
        console.log("Cliente desconectado. Encerrando o processo PTY...");
        ptyProcess.kill();
    });
});
