require("dotenv").config();

const express = require("express");
const axios = require("axios");
const sharp = require("sharp");
const FormData = require("form-data");
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs");
const path = require("path");
const os = require("os");
const webpmux = require("node-webpmux");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const OWNER_NUMBER = process.env.OWNER_NUMBER;

const GRAPH_URL =
    `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}`;

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
// FIGURINHAS
// ============================================================

const stickerMessages = new Map();

const MAX_STORED_STICKERS = 1000;

// ============================================================
// DATA DO BRASIL
// ============================================================

function getBrazilDate() {
    return new Intl.DateTimeFormat(
        "en-CA",
        {
            timeZone: "America/Sao_Paulo"
        }
    ).format(new Date());
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
// REGISTRAR FIGURINHA
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
// GUARDAR FIGURINHA NA MEMÓRIA
// ============================================================

function rememberSticker(
    messageId,
    mediaId,
    animated
) {
    if (!messageId || !mediaId) {
        console.log(
            "[STICKER] Não foi possível salvar:",
            {
                messageId,
                mediaId,
                animated
            }
        );

        return;
    }

    stickerMessages.set(
        messageId,
        {
            mediaId,
            animated: animated === true,
            createdAt: Date.now()
        }
    );

    console.log(
        "[STICKER] Figurinha salva na memória:",
        {
            messageId,
            mediaId,
            animated: animated === true,
            totalMemoria: stickerMessages.size
        }
    );

    if (
        stickerMessages.size >
        MAX_STORED_STICKERS
    ) {
        const firstKey =
            stickerMessages.keys()
                .next()
                .value;

        if (firstKey) {
            stickerMessages.delete(
                firstKey
            );
        }
    }
}

// ============================================================
// DADOS DO USUÁRIO / LIMITE
// ============================================================

function getUserData(userId) {
    const today =
        getBrazilDate();

    if (!users.has(userId)) {
        users.set(
            userId,
            {
                date: today,
                commands: 0
            }
        );
    }

    const user =
        users.get(userId);

    if (user.date !== today) {
        user.date = today;
        user.commands = 0;
    }

    return user;
}

function canUseCommand(userId) {
    if (
        unlimitedUsers.has(userId)
    ) {
        return true;
    }

    const user =
        getUserData(userId);

    if (
        user.commands >=
        DAILY_LIMIT
    ) {
        return false;
    }

    user.commands++;

    return true;
}

// ============================================================
// ENVIAR TEXTO
// ============================================================

async function sendText(
    to,
    text
) {
    await axios.post(
        `${GRAPH_URL}/messages`,
        {
            messaging_product:
                "whatsapp",

            to,

            type:
                "text",

            text: {
                body: text
            }
        },
        {
            headers: {
                Authorization:
                    `Bearer ${WHATSAPP_TOKEN}`,

                "Content-Type":
                    "application/json"
            }
        }
    );
}

// ============================================================
// DOWNLOAD DE MÍDIA
// ============================================================

async function downloadMedia(
    mediaId
) {
    console.log(
        "[MEDIA] Buscando informações da mídia:",
        mediaId
    );

    const mediaInfo =
        await axios.get(
            `https://graph.facebook.com/v23.0/${mediaId}`,
            {
                headers: {
                    Authorization:
                        `Bearer ${WHATSAPP_TOKEN}`
                }
            }
        );

    const mediaUrl =
        mediaInfo.data.url;

    if (!mediaUrl) {
        throw new Error(
            "A Meta não retornou uma URL para essa mídia."
        );
    }

    console.log(
        "[MEDIA] URL da mídia encontrada."
    );

    const response =
        await axios.get(
            mediaUrl,
            {
                responseType:
                    "arraybuffer",

                headers: {
                    Authorization:
                        `Bearer ${WHATSAPP_TOKEN}`
                }
            }
        );

    const buffer =
        Buffer.from(
            response.data
        );

    console.log(
        "[MEDIA] Download concluído:",
        buffer.length,
        "bytes"
    );

    return buffer;
}

// ============================================================
// UPLOAD DE MÍDIA
// ============================================================

async function uploadMedia(
    buffer,
    mimeType
) {
    console.log(
        "[UPLOAD] Enviando mídia:",
        {
            tamanho:
                buffer.length,

            mimeType
        }
    );

    const form =
        new FormData();

    form.append(
        "messaging_product",
        "whatsapp"
    );

    form.append(
        "file",
        buffer,
        {
            filename:
                "sticker.webp",

            contentType:
                mimeType
        }
    );

    const response =
        await axios.post(
            `${GRAPH_URL}/media`,
            form,
            {
                headers: {
                    Authorization:
                        `Bearer ${WHATSAPP_TOKEN}`,

                    ...form.getHeaders()
                }
            }
        );

    console.log(
        "[UPLOAD] Mídia enviada. ID:",
        response.data.id
    );

    return response.data.id;
}

// ============================================================
// ENVIAR FIGURINHA
// ============================================================

async function sendSticker(
    to,
    stickerBuffer,
    animated = false
) {
    const mediaId =
        await uploadMedia(
            stickerBuffer,
            "image/webp"
        );

    const response =
        await axios.post(
            `${GRAPH_URL}/messages`,
            {
                messaging_product:
                    "whatsapp",

                to,

                type:
                    "sticker",

                sticker: {
                    id: mediaId
                }
            },
            {
                headers: {
                    Authorization:
                        `Bearer ${WHATSAPP_TOKEN}`,

                    "Content-Type":
                        "application/json"
                }
            }
        );

    const messageId =
        response.data
            ?.messages?.[0]?.id;

    console.log(
        "[STICKER] Figurinha enviada:",
        {
            messageId,
            mediaId,
            animated
        }
    );

    if (
        messageId &&
        mediaId
    ) {
        rememberSticker(
            messageId,
            mediaId,
            animated
        );
    }

    return response.data;
}

// ============================================================
// FOTO -> STICKER
// ============================================================

async function imageToSticker(
    buffer
) {
    console.log(
        "[FIG] Convertendo imagem para sticker..."
    );

    const result =
        await sharp(buffer)
            .resize(
                512,
                512,
                {
                    fit:
                        "contain",

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

    console.log(
        "[FIG] Sticker criado:",
        result.length,
        "bytes"
    );

    return result;
}

// ============================================================
// VÍDEO -> STICKER ANIMADO
// ============================================================

async function videoToAnimatedSticker(
    buffer
) {
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
            (
                resolve,
                reject
            ) => {
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
                    .save(
                        outputPath
                    );
            }
        );
    };

    try {
        console.log(
            "[GIF] Convertendo vídeo..."
        );

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
            console.log(
                "[GIF] Arquivo passou de 500 KB. Reduzindo qualidade..."
            );

            await runFFmpeg(
                8,
                60
            );

            result =
                await fs.promises.readFile(
                    outputPath
                );
        }

        console.log(
            "[GIF] Sticker animado criado:",
            result.length,
            "bytes"
        );

        return result;

    } finally {
        await fs.promises.rm(
            tempDir,
            {
                recursive:
                    true,

                force:
                    true
            }
        );
    }
}

// ============================================================
// ADICIONAR METADADOS / DESCRIÇÃO DA FIGURINHA
// ============================================================

async function setStickerMetadata(
    buffer,
    descricao
) {
    console.log(
        "[TEXTO] Aplicando metadados:",
        descricao
    );

    if (
        !descricao ||
        !descricao.trim()
    ) {
        throw new Error(
            "A descrição da figurinha está vazia."
        );
    }

    const image =
        new webpmux.Image();

    await image.load(
        buffer
    );

    /*
     * Estrutura utilizada pelas figurinhas
     * do WhatsApp para armazenar informações
     * do pacote/autor.
     */

    const json =
        JSON.stringify({
            "sticker-pack-id":
                "com.rkdamirella.stickers",

            "sticker-pack-name":
                descricao.trim(),

            "sticker-pack-publisher":
                "rk da miis",

            "emojis":
                ["🤍"]
        });

    const jsonBuffer =
        Buffer.from(
            json,
            "utf8"
        );

    /*
     * Cabeçalho EXIF/TIFF utilizado
     * para inserir o JSON nos metadados
     * da figurinha.
     */

    const exifHeader =
        Buffer.from([
            0x49, 0x49,
            0x2A, 0x00,

            0x08, 0x00,
            0x00, 0x00,

            0x01, 0x00,

            0x41, 0x57,

            0x07, 0x00,

            0x00, 0x00,
            0x00, 0x00,

            0x16, 0x00,
            0x00, 0x00,

            0x00, 0x00,
            0x00, 0x00
        ]);

    /*
     * O tamanho do JSON fica armazenado
     * na posição 14 do bloco EXIF.
     */

    exifHeader.writeUInt32LE(
        jsonBuffer.length,
        14
    );

    const exif =
        Buffer.concat([
            exifHeader,
            jsonBuffer
        ]);

    image.exif =
        exif;

    /*
     * node-webpmux:
     * save(null) retorna o WebP
     * diretamente como Buffer.
     */

    const result =
        await image.save(
            null
        );

    console.log(
        "[TEXTO] Metadados aplicados:",
        result.length,
        "bytes"
    );

    return result;
}

// ============================================================
// WEBHOOK GET
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
                .send(
                    challenge
                );
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

            registerUser(
                from
            );

            console.log(
                "[MESSAGE]",
                {
                    from,
                    type:
                        message.type,

                    id:
                        message.id,

                    contextId:
                        message.context?.id
                }
            );

            // ====================================================
            // RECEBEU FIGURINHA
            // ====================================================

            if (
                message.type ===
                "sticker"
            ) {
                const sticker =
                    message.sticker;

                console.log(
                    "[STICKER RECEBIDO]",
                    {
                        messageId:
                            message.id,

                        mediaId:
                            sticker?.id,

                        animated:
                            sticker?.animated
                    }
                );

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
            // RECEBEU IMAGEM
            // ====================================================

            if (
                message.type ===
                "image"
            ) {
                const caption =
                    message.image
                        ?.caption
                        ?.trim()
                        .toLowerCase() ||
                    "";

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

                    await sendSticker(
                        from,
                        sticker,
                        false
                    );

                    registerSticker(
                        "fig"
                    );

                } catch (
                    error
                ) {
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
                    message.video
                        ?.caption
                        ?.trim()
                        .toLowerCase() ||
                    "";

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
                        sticker,
                        true
                    );

                    registerSticker(
                        "gif"
                    );

                } catch (
                    error
                ) {
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
            // TEXTO
            // ====================================================

            if (
                message.type !==
                "text"
            ) {
                return;
            }

            const text =
                message.text?.body
                    ?.trim() ||
                "";

            const lowerText =
                text.toLowerCase();

            // ====================================================
            // /ACESSOS
            // ====================================================

            if (
                lowerText ===
                "/acessos"
            ) {
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

                    `/texto — responda a uma figurinha com /texto seguido da descrição desejada.\n\n` +

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
                console.log(
                    "[TEXTO] ================================"
                );

                console.log(
                    "[TEXTO] Comando recebido:",
                    text
                );

                const descricao =
                    text
                        .slice(6)
                        .trim();

                if (
                    !descricao
                ) {
                    await sendText(
                        from,
                        `❌ Faltou a descrição.\n\n` +
                        `Responda a uma figurinha assim:\n` +
                        `/texto rk da miis`
                    );

                    return;
                }

                const repliedMessageId =
                    message.context?.id;

                console.log(
                    "[TEXTO] Mensagem respondida:",
                    repliedMessageId
                );

                if (
                    !repliedMessageId
                ) {
                    await sendText(
                        from,
                        `❌ Você precisa responder diretamente a uma figurinha.\n\n` +
                        `Exemplo:\n` +
                        `/texto rk da miis`
                    );

                    return;
                }

                const originalSticker =
                    stickerMessages.get(
                        repliedMessageId
                    );

                console.log(
                    "[TEXTO] Figurinha encontrada:",
                    originalSticker
                );

                if (
                    !originalSticker
                ) {
                    await sendText(
                        from,
                        `❌ Não encontrei essa figurinha na memória do bot.\n\n` +
                        `Envie a figurinha novamente e responda a ela.`
                    );

                    return;
                }

                try {
                    await sendText(
                        from,
                        "⏳ Aplicando a descrição na figurinha..."
                    );

                    const originalBuffer =
                        await downloadMedia(
                            originalSticker.mediaId
                        );

                    const finalSticker =
                        await setStickerMetadata(
                            originalBuffer,
                            descricao
                        );

                    await sendSticker(
                        from,
                        finalSticker,
                        originalSticker.animated
                    );

                    console.log(
                        "[TEXTO] Descrição aplicada com sucesso."
                    );

                } catch (
                    error
                ) {
                    console.error(
                        "[TEXTO] ================= ERRO ================="
                    );

                    console.error(
                        "[TEXTO] message:",
                        error.message
                    );

                    console.error(
                        "[TEXTO] stack:",
                        error.stack
                    );

                    if (
                        error.response
                    ) {
                        console.error(
                            "[TEXTO] API response:",
                            error.response.data
                        );
                    }

                    await sendText(
                        from,
                        "❌ Não consegui aplicar a descrição nessa figurinha."
                    );
                }

                return;
            }

            // ====================================================
            // /FIG
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
            // /GIF
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

        } catch (
            error
        ) {
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