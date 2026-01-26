const fs = require('fs');
const path = require('path');
const selfsigned = require('selfsigned');
const { app } = require('electron');
const logger = require('../utils/logger');

class CertificateManager {
  constructor() {
    // Usar diretório fixo para evitar problemas de contexto Electron
    this.certDir = path.join(__dirname, 'certs');
    this.certPath = path.join(this.certDir, 'server-cert.pem');
    this.keyPath = path.join(this.certDir, 'server-key.pem');
  }

  /**
   * Garante que existe um certificado SSL válido
   */
  ensureCertificate() {
    // Criar diretório se não existir
    if (!fs.existsSync(this.certDir)) {
      fs.mkdirSync(this.certDir, { recursive: true });
    }

    // Se já existe, validar conteúdo
    if (fs.existsSync(this.certPath) && fs.existsSync(this.keyPath)) {
      const cert = fs.readFileSync(this.certPath, 'utf8');
      const key = fs.readFileSync(this.keyPath, 'utf8');
      logger.info('Certificado SSL encontrado. Certificado e chave lidos.');
      if (cert && key && cert.length > 100 && key.length > 100) {
        logger.info('Certificado e chave parecem válidos.');
        return { cert, key };
      } else {
        logger.warn('Certificado ou chave inválidos/vazios. Gerando novamente...');
      }
    }

    // Gerar novo certificado
    logger.info('Gerando novo certificado SSL auto-assinado...');
    const attrs = [
      { name: 'commonName', value: 'localhost' },
      { name: 'organizationName', value: 'Thermal Print Service' }
    ];

    const options = {
      days: 365 * 10, // Válido por 10 anos
      algorithm: 'sha256',
      extensions: [
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: 'localhost' },
            { type: 2, value: '127.0.0.1' },
            { type: 7, ip: '127.0.0.1' }
          ]
        }
      ]
    };

    const pems = selfsigned.generate(attrs, options);

    // Salvar certificado e chave privada
    fs.writeFileSync(this.certPath, pems.cert);
    fs.writeFileSync(this.keyPath, pems.private);

    logger.info('Certificado SSL gerado com sucesso');
    return this.getCertificate();
  }

  /**
   * Retorna o certificado e chave privada
   */
  getCertificate() {
    const cert = fs.readFileSync(this.certPath, 'utf8');
    const key = fs.readFileSync(this.keyPath, 'utf8');
    logger.info(`[SSL] Certificado lido (${cert.length} chars)`);
    logger.info(`[SSL] Chave lida (${key.length} chars)`);
    return { cert, key };
  }

  /**
   * Retorna o caminho do certificado (para instalação no sistema)
   */
  getCertPath() {
    return this.certPath;
  }
}

module.exports = new CertificateManager();
