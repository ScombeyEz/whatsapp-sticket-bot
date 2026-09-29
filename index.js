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

const GRAPH_URL = `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}`;

const DAILY_LIMIT = 10;

// ===============================
// CONTROLE DE USUÁRIOS
// ===============================

const users = new Map();

// Usuários liberados pelo comando secreto.
// Volta a ficar vazio quando o bot reinicia.
const unlimitedUsers = new Set();

function getUserData(userId) {
    const today = new Date().toISOString().slice(0, 10);

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

    // Usuário liberado pelo comando secreto
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

// ===============================
// ENVIO DE TEXTO
// ===============================

async function sendText(to, text) {
    try {
        await axios.post(
            `${GRAPH_URL}/messages`,
            {
                messaging_product: "whatsapp",
                to: to,
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

        console.log(`Mensagem enviada para ${to}`);

    } catch (error) {

        console.error(
            "ERRO AO ENVIAR MENSAGEM:",
            error.response?.data || error.message
        );
    }
}

// ===============================
// DOWNLOAD DE MÍDIA
// ===============================

async function downloadMedia(mediaId) {
    try {

        const mediaInfo = await axios.get(
            `https://graph.facebook.com/v23.0/${mediaId}`,
            {
                headers: {
                    Authorization: `Bearer ${WHATSAPP_TOKEN}`
                }
            }
        );

        const mediaUrl = mediaInfo.data.url;

        const media = await axios.get(
            mediaUrl,
            {
                responseType: "arraybuffer",
                headers: {
                    Authorization: `Bearer ${WHATSAPP_TOKEN}`
                }
            }
        );

        return Buffer.from(media.data);

    } catch (error) {

        console.error(
            "ERRO AO BAIXAR MÍDIA:",
            error.response?.data || error.message
        );

        throw error;
    }
}

// ===============================
// UPLOAD DA FIGURINHA
// ===============================

async function uploadMedia(buffer, mimeType) {

    try {

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
            `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/media`,
            form,
            {
                headers: {
                    Authorization: `Bearer ${WHATSAPP_TOKEN}`,
                    ...form.getHeaders()
                }
            }
        );

        console.log("Mídia enviada para a Meta.");

        return response.data.id;

    } catch (error) {

        console.error(
            "ERRO NO UPLOAD:",
            error.response?.data || error.message
        );

        throw error;
    }
}

// ===============================
// ENVIO DE FIGURINHA
// ===============================

async function sendSticker(to, stickerBuffer) {

    try {

        const mediaId = await uploadMedia(
            stickerBuffer,
            "image/webp"
        );

        await axios.post(
            `${GRAPH_URL}/messages`,
            {
                messaging_product: "whatsapp",
                to: to,
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

        console.log(
            `Figurinha enviada para ${to}`
        );

    } catch (error) {

        console.error(
            "ERRO AO ENVIAR FIGURINHA:",
            error.response?.data || error.message
        );

        throw error;
    }
}

// ===============================
// FOTO → FIGURINHA
// ===============================

async function imageToSticker(buffer) {

    return await sharp(buffer)

        .resize(512, 512, {
            fit: "contain",
            background: {
                r: 0,
                g: 0,
                b: 0,
                alpha: 0
            }
        })

        .webp({
            quality: 80
        })

        .toBuffer();
}

// ===============================
// VÍDEO → FIGURINHA ANIMADA
// ===============================

async function videoToAnimatedSticker(buffer) {

    const tempDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "whatsapp-sticker-")
    );

    const inputPath = path.join(
        tempDir,
        "input.mp4"
    );

    const outputPath = path.join(
        tempDir,
        "sticker.webp"
    );

    try {

        await fs.promises.writeFile(
            inputPath,
            buffer
        );

        console.log(
            "Vídeo salvo temporariamente:",
            inputPath
        );

        await new Promise((resolve, reject) => {

            ffmpeg(inputPath)

                .outputOptions([
                    "-t 10",
                    "-an",
                    "-loop 0",
                    "-compression_level 6"
                ])

                .videoFilters([
                    "fps=10",
                    "scale=512:512:force_original_aspect_ratio=decrease",
                    "pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black@0"
                ])

                .videoCodec("libwebp")

                .outputOptions([
                    "-q:v 50"
                ])

                .format("webp")

                .on("start", command => {

                    console.log(
                        "FFmpeg iniciado:"
                    );

                    console.log(command);
                })

                .on("progress", progress => {

                    if (progress.percent) {

                        console.log(
                            `Conversão: ${Math.round(progress.percent)}%`
                        );
                    }
                })

                .on("end", () => {

                    console.log(
                        "Conversão concluída."
                    );

                    resolve();
                })

                .on("error", error => {

                    console.error(
                        "ERRO DO FFMPEG:",
                        error.message
                    );

                    reject(error);
                })

                .save(outputPath);
        });

        let stickerBuffer =
            await fs.promises.readFile(
                outputPath
            );

        if (stickerBuffer.length > 500 * 1024) {

            console.log(
                `Sticker ficou grande: ${Math.round(stickerBuffer.length / 1024)} KB`
            );

            await new Promise((resolve, reject) => {

                ffmpeg(inputPath)

                    .outputOptions([
                        "-t 10",
                        "-an",
                        "-loop 0",
                        "-compression_level 6"
                    ])

                    .videoFilters([
                        "fps=8",
                        "scale=512:512:force_original_aspect_ratio=decrease",
                        "pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black@0"
                    ])

                    .videoCodec("libwebp")

                    .outputOptions([
                        "-q:v 30"
                    ])

                    .format("webp")

                    .on("end", resolve)

                    .on("error", reject)

                    .save(outputPath);
            });

            stickerBuffer =
                await fs.promises.readFile(
                    outputPath
                );
        }

        if (stickerBuffer.length > 500 * 1024) {

            throw new Error(
                "O vídeo ficou maior que 500 KB mesmo após a compressão."
            );
        }

        console.log(
            `Sticker animado final: ${Math.round(stickerBuffer.length / 1024)} KB`
        );

        return stickerBuffer;

    } finally {

        try {

            await fs.promises.rm(
                tempDir,
                {
                    recursive: true,
                    force: true
                }
            );

            console.log(
                "Arquivos temporários removidos."
            );

        } catch (cleanupError) {

            console.error(
                "Erro ao limpar arquivos temporários:",
                cleanupError.message
            );
        }
    }
}

// ===============================
// VERIFICAÇÃO DO WEBHOOK
// ===============================

app.get("/webhook", (req, res) => {

    const mode =
        req.query["hub.mode"];

    const token =
        req.query["hub.verify_token"];

    const challenge =
        req.query["hub.challenge"];

    console.log(
        "Tentativa de verificação do webhook."
    );

    if (
        mode === "subscribe" &&
        token === VERIFY_TOKEN
    ) {

        console.log(
            "Webhook verificado pela Meta."
        );

        return res
            .status(200)
            .send(challenge);
    }

    console.log(
        "Falha na verificação do webhook."
    );

    return res.sendStatus(403);
});

// ===============================
// RECEBIMENTO DO WEBHOOK
// ===============================

app.post("/webhook", async (req, res) => {

    console.log("");
    console.log("====================================");
    console.log(" WEBHOOK RECEBIDO!");
    console.log("====================================");

    console.log(
        JSON.stringify(
            req.body,
            null,
            2
        )
    );

    console.log("====================================");
    console.log("");

    res.sendStatus(200);

    try {

        const entry =
            req.body.entry?.[0];

        const changes =
            entry?.changes?.[0];

        const value =
            changes?.value;

        const message =
            value?.messages?.[0];

        if (!message) {

            console.log(
                "Webhook recebido sem mensagem."
            );

            return;
        }

        const from =
            message.from;

        console.log(
            `Mensagem recebida de: ${from}`
        );

        console.log(
            `Tipo: ${message.type}`
        );

        // ===============================
        // TEXTO
        // ===============================

        if (message.type === "text") {

            const text =
                message.text?.body?.trim();

            if (!text) {
                return;
            }

            const command =
                text.toLowerCase();

            console.log(
                `Texto recebido: ${command}`
            );

            // ===============================
            // COMANDO SECRETO
            // ===============================

            if (command === "/rkdamirella") {

                unlimitedUsers.add(from);

                console.log(
                    `Usuário ${from} liberado para uso ilimitado.`
                );

                return;
            }

            // ===============================
            // /AJUDA
            // ===============================

            if (
                command === "/ajuda" ||
                command === "/help"
            ) {

                await sendText(
                    from,
                    `🤖 BOT DE FIGURINHAS

Comandos disponíveis:

/fig — envie uma foto com /fig para transformar em figurinha.

/gif — envie um vídeo com /gif para transformar em figurinha.

Limite diário: ${DAILY_LIMIT} comandos por usuário.

Exemplo:
Envie uma foto com a legenda /fig`
                );

                return;
            }

            // ===============================
            // /FIG
            // ===============================

            if (command === "/fig") {

                await sendText(
                    from,
                    "📸 Envie uma foto com a legenda /fig para transformá-la em figurinha."
                );

                return;
            }

            // ===============================
            // /GIF
            // ===============================

            if (command === "/gif") {

                await sendText(
                    from,
                    "🎬 Envie um vídeo com a legenda /gif para transformá-lo em figurinha."
                );

                return;
            }

            // ===============================
            // COMANDO DESCONHECIDO
            // ===============================

            await sendText(
                from,
                "❓ Comando não reconhecido.\n\nDigite /ajuda para ver os comandos."
            );

            return;
        }

        // ===============================
        // IMAGEM
        // ===============================

        if (message.type === "image") {

            const caption =
                message.image?.caption
                    ?.trim()
                    .toLowerCase();

            console.log(
                `Legenda da imagem: ${caption}`
            );

            if (caption !== "/fig") {

                await sendText(
                    from,
                    "📸 Para transformar essa foto em figurinha, envie novamente com a legenda /fig."
                );

                return;
            }

            if (!canUseCommand(from)) {

                await sendText(
                    from,
                    "⚠️ Você atingiu o limite de 10 comandos hoje. Tente novamente amanhã."
                );

                return;
            }

            await sendText(
                from,
                "⏳ Criando sua figurinha..."
            );

            const mediaId =
                message.image?.id;

            if (!mediaId) {

                console.log(
                    "Imagem recebida sem media ID."
                );

                return;
            }

            const original =
                await downloadMedia(
                    mediaId
                );

            const sticker =
                await imageToSticker(
                    original
                );

            await sendSticker(
                from,
                sticker
            );

            return;
        }

        // ===============================
        // VÍDEO
        // ===============================

        if (message.type === "video") {

            const caption =
                message.video?.caption
                    ?.trim()
                    .toLowerCase();

            console.log(
                `Legenda do vídeo: ${caption}`
            );

            if (caption !== "/gif") {

                await sendText(
                    from,
                    "🎬 Para transformar esse vídeo em figurinha, envie novamente com a legenda /gif."
                );

                return;
            }

            if (!canUseCommand(from)) {

                await sendText(
                    from,
                    "⚠️ Você atingiu o limite de 10 comandos hoje. Tente novamente amanhã."
                );

                return;
            }

            await sendText(
                from,
                "⏳ Recebi o vídeo! Estou criando sua figurinha animada..."
            );

            const mediaId =
                message.video?.id;

            if (!mediaId) {

                console.log(
                    "Vídeo recebido sem media ID."
                );

                return;
            }

            try {

                const original =
                    await downloadMedia(
                        mediaId
                    );

                console.log(
                    `Vídeo baixado: ${Math.round(original.length / 1024)} KB`
                );

                const sticker =
                    await videoToAnimatedSticker(
                        original
                    );

                await sendSticker(
                    from,
                    sticker
                );

                console.log(
                    "Figurinha animada enviada com sucesso!"
                );

            } catch (gifError) {

                console.error(
                    "ERRO AO PROCESSAR GIF:",
                    gifError.message
                );

                await sendText(
                    from,
                    "❌ Não consegui transformar esse vídeo em figurinha. Tente um vídeo de até 10 segundos."
                );
            }

            return;
        }

    } catch (error) {

        console.error(
            "ERRO PROCESSANDO WEBHOOK:",
            error.response?.data || error.message
        );
    }
});

// ===============================
// INICIAR SERVIDOR
// ===============================

app.listen(PORT, '0.0.0.0', () => {

    console.log(
        "===================================="
    );

    console.log(
        " BOT DE FIGURINHAS"
    );

    console.log(
        " WhatsApp Cloud API"
    );

    console.log(
        "===================================="
    );

    console.log(
        `Servidor iniciado na porta ${PORT}`
    );

    console.log(
        `Webhook: http://localhost:${PORT}/webhook`
    );

    console.log(
        "===================================="
    );
});