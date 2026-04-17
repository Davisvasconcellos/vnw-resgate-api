const express = require('express');
const router = express.Router();
const pdfService = require('../services/pdfService');
const { authenticateToken } = require('../middlewares/auth');

/**
 * @swagger
 * /api/v1/pdf/generate:
 *   post:
 *     summary: Gerar um PDF a partir de conteúdo HTML
 *     tags: [PDF]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - html
 *             properties:
 *               html:
 *                 type: string
 *                 description: Conteúdo HTML para renderizar no PDF
 *               filename:
 *                 type: string
 *                 description: Nome do arquivo PDF (padrão "documento.pdf")
 *               options:
 *                 type: object
 *                 description: Opções do Puppeteer (format, margin, landscape, etc.)
 *     responses:
 *       200:
 *         description: PDF gerado com sucesso
 *         content:
 *           application/pdf:
 *             schema:
 *               type: string
 *               format: binary
 *       400:
 *         description: HTML não fornecido
 */
router.post('/generate', authenticateToken, async (req, res) => {
  try {
    const { html, filename = 'documento.pdf', options = {} } = req.body;

    if (!html) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'O campo "html" é obrigatório.'
      });
    }

    const pdfBuffer = await pdfService.generatePdf(html, options);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);

  } catch (error) {
    console.error('PDF generation error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Erro ao gerar PDF'
    });
  }
});

module.exports = router;
