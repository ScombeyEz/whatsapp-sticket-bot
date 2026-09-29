require("dotenv").config();

const express = require("express");
const axios = require("axios");
const sharp = require("sharp");
const FormData = require("form-data");
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const OWNER_NUMBER = process.env.OWNER_NUMBER;

const GRAPH_URL = `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}`;

const DAILY_LIMIT = 10;

// ============================================================
// USUÁRIOS
// ============================================================

const users = new Map();
const unlimitedUsers = new Set();

// ============================================================
// ESTATÍSTICAS
// ============================================================

const allUsers = new Set();
const dailyUsers = new Set();

const stats = {
    totalStickers: 0,
    totalFig: 0,
    totalGif: 0,

    dailyStickers: 0,
    dailyFig: 0,
    dailyGif: 0,

    date: getBrazilDate()
};

// ============================================================
// FIGURINHAS RECEBIDAS
// ============================================================

// Guarda a relação:
// ID da mensagem do WhatsApp -> ID da mídia da figurinha
//
// Isso permite que:
// o usuário responda uma figurinha
// e use /texto alguma coisa

const stickerMessages = new Map();

const MAX_STORED_STICKERS = 1000;

// ============================================================
// DATA DO BRASIL
// ============================================================

function getBrazilDate() {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Sao_Paulo"
    }).format(new Date());
}

// ============================================================
// RESET DAS ESTATÍSTICAS DIÁRIAS
// ============================================================

function resetDailyStatsIfNeeded() {
    const today = getBrazilDate();

    if (stats.date !== today) {
        stats.date = today;

        stats.dailyStickers = 0;
        stats.dailyFig = 0;
        stats.dailyGif = 0;

        dailyUsers.clear();
    }
}

// ============================================================
// REGISTRAR USUÁRIO
// ============================================================

function registerUser(userId) {
    resetDailyStatsIfNeeded();

    allUsers.add(userId);
    dailyUsers.add(userId);
}

// ============================================================
// REGISTRAR FIGURINHA CRIADA
// ============================================================

function registerSticker(type) {
    resetDailyStatsIfNeeded();

    stats.totalStickers++;
    stats.dailyStickers++;

    if (type === "fig") {
        stats.totalFig++;
        stats.dailyFig++;
    }

    if (type === "gif") {
        stats.totalGif++;
        stats.dailyGif++;
    }
}

// ============================================================
// GUARDAR FIGURINHA
// ============================================================

function rememberSticker(messageId, mediaId, animated) {
    if (!messageId || !mediaId) {
        return;
    }

    stickerMessages.set(messageId, {
        mediaId,
        animated: animated === true,
        createdAt: Date.now()
    });

    // Evita crescimento infinito da memória
    if (stickerMessages.size > MAX_STORED_STICKERS) {
        const firstKey =
            stickerMessages.keys().next().value;

        if (firstKey) {
            stickerMessages.delete(firstKey);
        }
    }
}

// ============================================================
// DADOS DO USUÁRIO / LIMITE
// ============================================================

function getUserData(userId) {
    const today = getBrazilDate();

    if (!users.has(userId)) {
        users.set(userId, {
            date: today,
            commands: 0
        });
    }

    const user = users.get(userId);

    if (user.date !== today) {
        user.date = today;
        user.commands = 0;
    }

    return user;
}

function canUseCommand(userId) {
    if (unlimitedUsers.has(userId)) {
        return true;
    }

    const user = getUserData(userId);

    if (user.commands >= DAILY_LIMIT) {
        return false;
    }

    user.commands++;

    return true;
}

// ============================================================
// ENVIAR TEXTO
// ============================================================

async function sendText(to, text) {
    await axios.post(
        `${GRAPH_URL}/messages`,
        {
            messaging_product: "whatsapp",
            to,
            type: "text",
            text: {
                body: text
            }
        },
        {
            headers: {
                Authorization: `Bearer ${WHATSAPP_TOKEN}`,
                "Content-Type": "application/json"
            }
        }
    );
}

// ============================================================
// DOWNLOAD DE MÍDIA
// ============================================================

async function downloadMedia(mediaId) {
    const mediaInfo = await axios.get(
        `https://graph.facebook.com/v23.0/${mediaId}`,
        {
            headers: {
                Authorization: `Bearer ${WHATSAPP_TOKEN}`
            }
        }
    );

    const mediaUrl = mediaInfo.data.url;

    const response = await axios.get(
        mediaUrl,
        {
            responseType: "arraybuffer",
            headers: {
                Authorization: `Bearer ${WHATSAPP_TOKEN}`
            }
        }
    );

    return Buffer.from(response.data);
}

// ============================================================
// UPLOAD DE MÍDIA
// ============================================================

async function uploadMedia(buffer, mimeType) {
    const form = new FormData();

    form.append(
        "messaging_product",
        "whatsapp"
    );

    form.append(
        "file",
        buffer,
        {
            filename: "sticker.webp",
            contentType: mimeType
        }
    );

    const response = await axios.post(
        `${GRAPH_URL}/media`,
        form,
        {
            headers: {
                Authorization: `Bearer ${WHATSAPP_TOKEN}`,
                ...form.getHeaders()
            }
        }
    );

    return response.data.id;
}

// ============================================================
// ENVIAR FIGURINHA
// ============================================================

async function sendSticker(to, stickerBuffer) {
    const mediaId = await uploadMedia(
        stickerBuffer,
        "image/webp"
    );

    const response = await axios.post(
        `${GRAPH_URL}/messages`,
        {
            messaging_product: "whatsapp",
            to,
            type: "sticker",
            sticker: {
                id: mediaId
            }
        },
        {
            headers: {
                Authorization: `Bearer ${WHATSAPP_TOKEN}`,
                "Content-Type": "application/json"
            }
        }
    );

    return response.data;
}

// ============================================================
// FOTO -> STICKER
// ============================================================

async function imageToSticker(buffer) {
    return await sharp(buffer)
        .resize(
            512,
            512,
            {
                fit: "contain",
                background: {
                    r: 0,
                    g: 0,
                    b: 0,
                    alpha: 0
                }
            }
        )
        .webp({
            quality: 80
        })
        .toBuffer();
}

// ============================================================
// VÍDEO -> STICKER ANIMADO
// ============================================================

async function videoToAnimatedSticker(buffer) {
    const tempDir =
        await fs.promises.mkdtemp(
            path.join(
                os.tmpdir(),
                "whatsapp-sticker-"
            )
        );

    const inputPath =
        path.join(
            tempDir,
            "input"
        );

    const outputPath =
        path.join(
            tempDir,
            "output.webp"
        );

    await fs.promises.writeFile(
        inputPath,
        buffer
    );

    const runFFmpeg = (
        fps,
        quality
    ) => {
        return new Promise(
            (resolve, reject) => {
                ffmpeg(inputPath)
                    .outputOptions([
                        "-t",
                        "10",

                        "-vf",
                        `fps=${fps},scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black@0`,

                        "-an",

                        "-loop",
                        "0",

                        "-c:v",
                        "libwebp",

                        "-q:v",
                        String(quality),

                        "-compression_level",
                        "6",

                        "-preset",
                        "picture"
                    ])
                    .format("webp")
                    .on(
                        "end",
                        resolve
                    )
                    .on(
                        "error",
                        reject
                    )
                    .save(outputPath);
            }
        );
    };

    try {
        await runFFmpeg(
            10,
            45
        );

        let result =
            await fs.promises.readFile(
                outputPath
            );

        if (
            result.length >
            500 * 1024
        ) {
            await runFFmpeg(
                8,
                60
            );

            result =
                await fs.promises.readFile(
                    outputPath
                );
        }

        return result;

    } finally {
        await fs.promises.rm(
            tempDir,
            {
                recursive: true,
                force: true
            }
        );
    }
}

// ============================================================
// ESCAPAR XML
// ============================================================

function escapeXml(text) {
    return text
        .replace(
            /&/g,
            "&amp;"
        )
        .replace(
            /</g,
            "&lt;"
        )
        .replace(
            />/g,
            "&gt;"
        )
        .replace(
            /"/g,
            "&quot;"
        )
        .replace(
            /'/g,
            "&apos;"
        );
}

// ============================================================
// QUEBRA DE TEXTO
// ============================================================

function wrapText(
    text,
    maxChars
) {
    const words =
        text.split(/\s+/);

    const lines = [];

    let current = "";

    for (
        const word of words
    ) {
        if (!current) {
            current = word;
            continue;
        }

        const test =
            `${current} ${word}`;

        if (
            test.length <=
            maxChars
        ) {
            current = test;
        } else {
            lines.push(current);
            current = word;
        }
    }

    if (current) {
        lines.push(current);
    }

    return lines.slice(
        0,
        5
    );
}

// ============================================================
// CRIAR TEXTO SVG
// ============================================================

function createTextSvg(
    text,
    width = 512,
    height = 512
) {
    const safeText =
        escapeXml(text);

    const lines =
        wrapText(
            safeText,
            22
        );

    const fontSize =
        lines.length >= 4
            ? 40
            : lines.length >= 3
                ? 46
                : 52;

    const lineHeight =
        fontSize + 8;

    const totalHeight =
        lines.length *
        lineHeight;

    const startY =
        height -
        totalHeight -
        35;

    let textElements = "";

    lines.forEach(
        (
            line,
            index
        ) => {
            const y =
                startY +
                index *
                lineHeight;

            textElements += `
                <text
                    x="50%"
                    y="${y}"
                    text-anchor="middle"
                    font-family="Arial, DejaVu Sans, sans-serif"
                    font-size="${fontSize}px"
                    font-weight="bold"
                    fill="white"
                    stroke="black"
                    stroke-width="10"
                    stroke-linejoin="round"
                    paint-order="stroke fill"
                >${line}</text>
            `;
        }
    );

    return `
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="${width}"
            height="${height}"
        >
            ${textElements}
        </svg>
    `;
}

// ============================================================
// TEXTO EM STICKER ESTÁTICO
// ============================================================

async function addTextToStaticSticker(
    buffer,
    text
) {
    const metadata =
        await sharp(buffer)
            .metadata();

    const width =
        metadata.width ||
        512;

    const height =
        metadata.height ||
        512;

    const svg =
        createTextSvg(
            text,
            width,
            height
        );

    return await sharp(buffer)
        .composite([
            {
                input:
                    Buffer.from(svg),
                top: 0,
                left: 0
            }
        ])
        .webp({
            quality: 80
        })
        .toBuffer();
}

// ============================================================
// TEXTO EM STICKER ANIMADO
// ============================================================

async function addTextToAnimatedSticker(
    buffer,
    text
) {
    const tempDir =
        await fs.promises.mkdtemp(
            path.join(
                os.tmpdir(),
                "sticker-text-"
            )
        );

    const inputPath =
        path.join(
            tempDir,
            "input.webp"
        );

    const overlayPath =
        path.join(
            tempDir,
            "text.png"
        );

    const outputPath =
        path.join(
            tempDir,
            "output.webp"
        );

    try {
        await fs.promises.writeFile(
            inputPath,
            buffer
        );

        const svg =
            createTextSvg(
                text,
                512,
                512
            );

        const overlay =
            await sharp(
                Buffer.from(svg)
            )
                .png()
                .toBuffer();

        await fs.promises.writeFile(
            overlayPath,
            overlay
        );

        const runFFmpeg = (
            quality
        ) => {
            return new Promise(
                (
                    resolve,
                    reject
                ) => {
                    ffmpeg()
                        .input(inputPath)

                        .input(
                            overlayPath
                        )

                        .inputOptions([
                            "-loop",
                            "1"
                        ])

                        .complexFilter([
                            "[1:v]format=rgba[text]",
                            "[0:v][text]overlay=0:0:shortest=1"
                        ])

                        .outputOptions([
                            "-an",

                            "-loop",
                            "0",

                            "-c:v",
                            "libwebp",

                            "-q:v",
                            String(
                                quality
                            ),

                            "-compression_level",
                            "6",

                            "-preset",
                            "picture"
                        ])

                        .format("webp")

                        .on(
                            "end",
                            resolve
                        )

                        .on(
                            "error",
                            reject
                        )

                        .save(
                            outputPath
                        );
                }
            );
        };

        await runFFmpeg(
            50
        );

        let result =
            await fs.promises.readFile(
                outputPath
            );

        if (
            result.length >
            500 * 1024
        ) {
            await runFFmpeg(
                65
            );

            result =
                await fs.promises.readFile(
                    outputPath
                );
        }

        return result;

    } finally {
        await fs.promises.rm(
            tempDir,
            {
                recursive: true,
                force: true
            }
        );
    }
}

// ============================================================
// WEBHOOK GET - VERIFICAÇÃO META
// ============================================================

app.get(
    "/webhook",
    (
        req,
        res
    ) => {
        const mode =
            req.query[
                "hub.mode"
            ];

        const token =
            req.query[
                "hub.verify_token"
            ];

        const challenge =
            req.query[
                "hub.challenge"
            ];

        if (
            mode === "subscribe" &&
            token === VERIFY_TOKEN
        ) {
            console.log(
                "Webhook verificado com sucesso."
            );

            return res
                .status(200)
                .send(challenge);
        }

        return res
            .sendStatus(403);
    }
);

// ============================================================
// WEBHOOK POST
// ============================================================

app.post(
    "/webhook",
    async (
        req,
        res
    ) => {

        console.log(
            "Webhook recebido:",
            JSON.stringify(
                req.body,
                null,
                2
            )
        );

        // Responde para a Meta imediatamente
        res.sendStatus(200);

        try {
            const entry =
                req.body?.entry?.[0];

            const change =
                entry?.changes?.[0];

            const value =
                change?.value;

            const message =
                value?.messages?.[0];

            if (!message) {
                return;
            }

            const from =
                message.from;

            registerUser(from);

            // ====================================================
            // RECEBEU UMA FIGURINHA
            // ====================================================

            if (
                message.type ===
                "sticker"
            ) {
                const sticker =
                    message.sticker;

                if (
                    sticker?.id
                ) {
                    rememberSticker(
                        message.id,
                        sticker.id,
                        sticker.animated === true
                    );
                }

                return;
            }

            // ====================================================
            // RECEBEU UMA IMAGEM
            // ====================================================

            if (
                message.type ===
                "image"
            ) {
                const caption =
                    message.image?.caption
                        ?.trim()
                        .toLowerCase() || "";

                if (
                    caption !==
                    "/fig"
                ) {
                    return;
                }

                if (
                    !canUseCommand(
                        from
                    )
                ) {
                    await sendText(
                        from,
                        `❌ Você atingiu o limite diário de ${DAILY_LIMIT} comandos /fig + /gif.\n\n` +
                        `O limite será renovado automaticamente à meia-noite.`
                    );

                    return;
                }

                try {
                    await sendText(
                        from,
                        "⏳ Processando sua figurinha..."
                    );

                    const buffer =
                        await downloadMedia(
                            message.image.id
                        );

                    const sticker =
                        await imageToSticker(
                            buffer
                        );

                    const result =
                        await sendSticker(
                            from,
                            sticker
                        );

                    registerSticker(
                        "fig"
                    );

                    // Guarda a figurinha enviada pelo bot
                    const sentMessageId =
                        result?.messages?.[0]?.id;

                    if (
                        sentMessageId
                    ) {
                        // A mídia enviada pelo bot é a mesma que foi criada
                        // localmente. Não precisamos dela para o /texto
                        // caso o usuário responda à figurinha original.
                    }

                } catch (error) {
                    console.error(
                        "Erro no /fig:",
                        error.response?.data ||
                        error.message ||
                        error
                    );

                    await sendText(
                        from,
                        "❌ Não consegui transformar essa imagem em figurinha."
                    );
                }

                return;
            }

            // ====================================================
            // RECEBEU VÍDEO
            // ====================================================

            if (
                message.type ===
                "video"
            ) {
                const caption =
                    message.video?.caption
                        ?.trim()
                        .toLowerCase() || "";

                if (
                    caption !==
                    "/gif"
                ) {
                    return;
                }

                if (
                    !canUseCommand(
                        from
                    )
                ) {
                    await sendText(
                        from,
                        `❌ Você atingiu o limite diário de ${DAILY_LIMIT} comandos /fig + /gif.\n\n` +
                        `O limite será renovado automaticamente à meia-noite.`
                    );

                    return;
                }

                try {
                    await sendText(
                        from,
                        "⏳ Processando sua figurinha animada..."
                    );

                    const buffer =
                        await downloadMedia(
                            message.video.id
                        );

                    const sticker =
                        await videoToAnimatedSticker(
                            buffer
                        );

                    await sendSticker(
                        from,
                        sticker
                    );

                    registerSticker(
                        "gif"
                    );

                } catch (error) {
                    console.error(
                        "Erro no /gif:",
                        error.response?.data ||
                        error.message ||
                        error
                    );

                    await sendText(
                        from,
                        "❌ Não consegui transformar esse vídeo em figurinha animada."
                    );
                }

                return;
            }

            // ====================================================
            // SÓ PROCESSA TEXTO A PARTIR DAQUI
            // ====================================================

            if (
                message.type !==
                "text"
            ) {
                return;
            }

            const text =
                message.text?.body
                    ?.trim() || "";

            const lowerText =
                text.toLowerCase();

            // ====================================================
            // /ACESSOS
            // ====================================================

            if (
                lowerText ===
                "/acessos"
            ) {

                // Somente o desenvolvedor
                if (
                    from !==
                    OWNER_NUMBER
                ) {
                    return;
                }

                resetDailyStatsIfNeeded();

                const mensagem =
                    `📊 ESTATÍSTICAS DO BOT\n\n` +

                    `👥 Usuários hoje: ${dailyUsers.size}\n` +
                    `👥 Usuários totais: ${allUsers.size}\n\n` +

                    `🎨 Figurinhas hoje: ${stats.dailyStickers}\n` +
                    `🎨 Figurinhas totais: ${stats.totalStickers}\n\n` +

                    `🖼️ /fig hoje: ${stats.dailyFig}\n` +
                    `🖼️ /fig total: ${stats.totalFig}\n\n` +

                    `🎬 /gif hoje: ${stats.dailyGif}\n` +
                    `🎬 /gif total: ${stats.totalGif}`;

                await sendText(
                    from,
                    mensagem
                );

                return;
            }

            // ====================================================
            // /RKDAMIRELLA
            // ====================================================

            if (
                lowerText ===
                "/rkdamirella"
            ) {
                unlimitedUsers.add(
                    from
                );

                return;
            }

            // ====================================================
            // /AJUDA
            // ====================================================

            if (
                lowerText ===
                    "/ajuda" ||
                lowerText ===
                    "/help"
            ) {
                await sendText(
                    from,
                    `🤖 COMANDOS DO BOT\n\n` +

                    `/fig — envie uma foto com /fig para transformar em figurinha.\n\n` +

                    `/gif — envie um vídeo com /gif para transformar em figurinha animada.\n\n` +

                    `/texto — responda a uma figurinha com /texto seguido do texto desejado.\n\n` +

                    `⚠️ Limite diário: ${DAILY_LIMIT} comandos /fig + /gif.`
                );

                return;
            }

            // ====================================================
            // /TEXTO
            // ====================================================

            if (
                lowerText ===
                    "/texto" ||
                lowerText.startsWith(
                    "/texto "
                )
            ) {

                const textToAdd =
                    text
                        .slice(6)
                        .trim();

                if (
                    !textToAdd
                ) {
                    await sendText(
                        from,
                        `❌ Faltou o texto.\n\n` +
                        `Responda a uma figurinha assim:\n\n` +
                        `/texto seu texto aqui`
                    );

                    return;
                }

                // ID da mensagem que o usuário está respondendo
                const repliedMessageId =
                    message.context?.id;

                if (
                    !repliedMessageId
                ) {
                    await sendText(
                        from,
                        `❌ Você precisa responder diretamente a uma figurinha.\n\n` +
                        `Exemplo:\n` +
                        `/texto seu texto aqui`
                    );

                    return;
                }

                const originalSticker =
                    stickerMessages.get(
                        repliedMessageId
                    );

                if (
                    !originalSticker
                ) {
                    await sendText(
                        from,
                        `❌ Não encontrei essa figurinha na memória do bot.\n\n` +
                        `Tente enviar a figurinha novamente e depois responda a ela com /texto.`
                    );

                    return;
                }

                try {
                    await sendText(
                        from,
                        "⏳ Adicionando o texto na figurinha..."
                    );

                    const originalBuffer =
                        await downloadMedia(
                            originalSticker.mediaId
                        );

                    let finalSticker;

                    if (
                        originalSticker.animated
                    ) {
                        finalSticker =
                            await addTextToAnimatedSticker(
                                originalBuffer,
                                textToAdd
                            );
                    } else {
                        finalSticker =
                            await addTextToStaticSticker(
                                originalBuffer,
                                textToAdd
                            );
                    }

                    await sendSticker(
                        from,
                        finalSticker
                    );

                } catch (error) {
                    console.error(
                        "Erro no /texto:",
                        error.response?.data ||
                        error.message ||
                        error
                    );

                    await sendText(
                        from,
                        "❌ Não consegui adicionar o texto nessa figurinha."
                    );
                }

                return;
            }

            // ====================================================
            // TEXTO /FIG
            // ====================================================

            if (
                lowerText ===
                "/fig"
            ) {
                await sendText(
                    from,
                    `📸 Para criar uma figurinha, envie a foto com /fig na legenda.\n\nExemplo: envie a foto e coloque /fig na legenda.`
                );

                return;
            }

            // ====================================================
            // TEXTO /GIF
            // ====================================================

            if (
                lowerText ===
                "/gif"
            ) {
                await sendText(
                    from,
                    `🎬 Para criar uma figurinha animada, envie o vídeo com /gif na legenda.`
                );

                return;
            }

            // ====================================================
            // COMANDO DESCONHECIDO
            // ====================================================

            if (
                lowerText.startsWith(
                    "/"
                )
            ) {
                await sendText(
                    from,
                    `❌ Comando não reconhecido.\n\nDigite /ajuda para ver os comandos disponíveis.`
                );

                return;
            }

        } catch (error) {
            console.error(
                "Erro geral no webhook:",
                error.response?.data ||
                error.message ||
                error
            );
        }
    }
);

// ============================================================
// STATUS
// ============================================================

app.get(
    "/",
    (
        req,
        res
    ) => {
        res.status(200).send(
            "WhatsApp Sticker Bot online."
        );
    }
);

// ============================================================
// INICIAR SERVIDOR
// ============================================================

app.listen(
    PORT,
    "0.0.0.0",
    () => {
        console.log(
            `Servidor iniciado na porta ${PORT}`
        );

        console.log(
            `Webhook: http://localhost:${PORT}/webhook`
        );

        console.log(
            "WhatsApp Sticker Bot iniciado."
        );
    }
);