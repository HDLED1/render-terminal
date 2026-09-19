const os = require('os');
const pty = require('node-pty');
const WebSocket = require('ws');

// Inicia o servidor WebSocket na porta 8080
const wss = new WebSocket.Server({ port: 8080 });

console.log("Servidor WebSocket rodando na porta 8080...");

wss.on('connection', (ws) => {
    console.log("Novo cliente conectado!");

    // Define o shell (bash no Linux/Mac, powershell no Windows)
    const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';

    // Cria o pseudo-terminal (PTY)
    const ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-color',
        cols: 80, // Você pode capturar isso do frontend dinamicamente depois
        rows: 24,
        cwd: process.env.HOME || process.cwd(), // Pasta inicial
        env: process.env // Passa as variáveis de ambiente (PATH, etc)
    });

    // 1. LER DO TERMINAL -> ENVIAR PARA O FRONTEND
    ptyProcess.onData((data) => {
        // Envia o output (texto, cores ANSI, etc) de volta pro xterm.js
        ws.send(data);
    });

    // 2. LER DO FRONTEND -> ENVIAR PARA O TERMINAL
    ws.on('message', (message) => {
        // O xterm.js envia os caracteres (ex: teclas digitadas)
        ptyProcess.write(message.toString());
    });

    // 3. LIMPEZA QUANDO O USUÁRIO FECHAR A ABA
    ws.on('close', () => {
        console.log("Cliente desconectado. Encerrando o processo PTY...");
        ptyProcess.kill();
    });
});
