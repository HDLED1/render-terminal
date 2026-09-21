'use strict';

// =============================================================================
// IMPORTS — validados individualmente para dar mensagens de erro claras
// =============================================================================

function loadModule(name) {
    try {
        return require(name);
    } catch (err) {
        console.error(`[FATAL] Não foi possível carregar o módulo "${name}".`);
        console.error(`         Ele está instalado? Tente: npm install ${name}`);
        console.error(`         Detalhe técnico: ${err.message}`);
        process.exit(1);
    }
}

const os = require('os');       // módulo nativo, não falha
const pty = loadModule('node-pty');
const WebSocket = loadModule('ws');

// =============================================================================
// CONFIGURAÇÃO
// =============================================================================

let PORT = 8080;
if (process.env.PORT !== undefined) {
    const parsed = parseInt(process.env.PORT, 10);
    if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
        console.warn(`[AVISO] Valor de PORT inválido ("${process.env.PORT}"). Usando 8080.`);
    } else {
        PORT = parsed;
    }
}

// =============================================================================
// CRIAÇÃO DO SERVIDOR
// =============================================================================

let wss;

try {
    // Erros síncronos: opções inválidas, etc.
    wss = new WebSocket.Server({ port: PORT });
} catch (err) {
    console.error(`[FATAL] Falha ao criar o servidor WebSocket na porta ${PORT}:`);
    console.error(`         ${err.message}`);
    process.exit(1);
}

// ERROS ASSÍNCRONOS do servidor (ex.: EADDRINUSE chega por aqui, não no construtor!)
wss.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`[FATAL] A porta ${PORT} já está em uso por outro processo.`);
        console.error(`         Descubra quem: lsof -i :${PORT} (Linux/Mac) ou netstat -ano | findstr ${PORT} (Windows)`);
    } else if (err.code === 'EACCES') {
        console.error(`[FATAL] Sem permissão para usar a porta ${PORT} (portas < 1024 exigem privilégio).`);
    } else {
        console.error('[FATAL] Erro inesperado no servidor WebSocket:', err);
    }
    process.exit(1);
});

wss.on('listening', () => {
    console.log(`[INFO] Servidor WebSocket rodando na porta ${PORT} (${os.platform()})`);
});

// =============================================================================
// ERROS GLOBAIS E ENCERRAMENTO
// =============================================================================

process.on('uncaughtException', (err) => {
    console.error('[ERRO FATAL] Exceção não tratada — o processo será encerrado:');
    console.error(err);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error('[ERRO] Promise rejeitada e não tratada (o processo continua):');
    console.error(reason);
});

function shutdown(signal) {
    console.log(`\n[INFO] Sinal ${signal} recebido. Encerrando ${wss.clients.size} cliente(s)...`);

    for (const client of wss.clients) {
        try {
            client.close(1001, 'Servidor encerrando');
        } catch (err) {
            console.warn(`[AVISO] Falha ao fechar um cliente no encerramento: ${err.message}`);
        }
    }

    wss.close(() => {
        console.log('[INFO] Servidor encerrado corretamente.');
        process.exit(0);
    });

    // Rede de segurança: se o encerramento gracioso travar, força a saída em 3s
    setTimeout(() => {
        console.warn('[AVISO] Encerramento gracioso demorou demais. Forçando saída.');
        process.exit(0);
    }, 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// =============================================================================
// CONEXÃO DE CLIENTE
// =============================================================================

wss.on('connection', (ws, req) => {
    const clientId = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
    const tag = `[cliente ${clientId}]`;

    console.log(`${tag} conectado.`);

    // CRÍTICO: sem listener de 'error', um erro de socket vira exceção não tratada
    // e derruba o processo inteiro.
    ws.on('error', (err) => {
        console.error(`${tag} [ERRO] Erro na conexão WebSocket: ${err.message}`);
    });

    // ---- Escolha do shell ----
    const shell = os.platform() === 'win32'
        ? 'powershell.exe'
        : (process.env.SHELL || 'bash');

    // ---- Início do PTY ----
    let ptyProcess;

    try {
        ptyProcess = pty.spawn(shell, [], {
            name: 'xterm-color',
            cols: 80,
            rows: 24,
            // '/root' não existe se o usuário não for root — o spawn falharia com ENOENT
            cwd: process.env.HOME || process.cwd(),
            env: process.env
        });
    } catch (err) {
        console.error(`${tag} [ERRO] Falha ao iniciar o terminal (shell: "${shell}"): ${err.message}`);

        // Avisa o cliente e fecha com código 1011 (erro interno do servidor)
        try {
            ws.send(`\r\n\x1b[31mErro ao iniciar o terminal no servidor.\x1b[0m\r\n` +
                    `Shell tentado: ${shell}\r\n` +
                    `Motivo: ${err.message}\r\n`);
            ws.close(1011, 'Falha ao iniciar terminal');
        } catch (sendErr) {
            // O socket pode já estar em estado inconsistente depois de um erro
            console.warn(`${tag} [AVISO] Não foi possível avisar o cliente do erro: ${sendErr.message}`);
        }
        return;
    }

    console.log(`${tag} PTY iniciado (pid ${ptyProcess.pid}, shell: ${shell}).`);

    // Evita escrever/matar um processo que já morreu (condição de corrida comum)
    let ptyAlive = true;

    // ---- TERMINAL -> CLIENTE ----
    ptyProcess.onData((data) => {
        if (ws.readyState !== WebSocket.OPEN) {
            return; // cliente já saiu, nada a fazer
        }

        // O callback é onde erros de envio assíncronos aparecem
        ws.send(data, (sendErr) => {
            if (sendErr) {
                console.error(`${tag} [ERRO] Falha ao enviar saída do terminal ao cliente: ${sendErr.message}`);
            }
        });
    });

    // ---- CLIENTE -> TERMINAL ----
    ws.on('message', (data, isBinary) => {
        if (!ptyAlive) {
            console.warn(`${tag} [AVISO] Entrada recebida após o terminal encerrar. Ignorando.`);
            return;
        }

        const texto = isBinary ? data.toString('utf8') : data.toString();

        try {
            // write() lança erro (EPIPE/EINVAL) se o processo já morreu
            ptyProcess.write(texto);
        } catch (err) {
            console.error(`${tag} [ERRO] Falha ao escrever no terminal: ${err.message}`);
        }
    });

    // ---- TÉRMINO DO PROCESSO DO TERMINAL ----
    ptyProcess.onExit(({ exitCode, signal }) => {
        ptyAlive = false;

        // exitCode/signal podem ser undefined dependendo de como o processo morreu
        console.log(`${tag} PTY encerrou (código: ${exitCode ?? 'n/d'}, sinal: ${signal ?? 'nenhum'}).`);

        if (ws.readyState === WebSocket.OPEN) {
            try {
                ws.close(1000, 'Terminal encerrou');
            } catch (err) {
                console.warn(`${tag} [AVISO] Falha ao fechar a conexão após o terminal encerrar: ${err.message}`);
            }
        }
    });

    // ---- DESCONECTOU / FECHOU A ABA ----
    ws.on('close', (code, reason) => {
        const motivo = reason && reason.length > 0 ? reason.toString() : 'sem motivo informado';
        console.log(`${tag} desconectou (código: ${code}, motivo: ${motivo}).`);

        if (ptyAlive) {
            console.log(`${tag} Encerrando o PTY (pid ${ptyProcess.pid})...`);
            try {
                ptyProcess.kill();
            } catch (err) {
                // O mais comum: o processo morreu sozinho entre o evento e o kill()
                console.warn(`${tag} [AVISO] Falha ao encerrar o PTY (provavelmente já saiu): ${err.message}`);
            }
        }
    });
});
