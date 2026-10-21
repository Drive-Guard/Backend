/**
 * IDs digitados pelo gestor e gravados no dispositivo da cabine (motorista e
 * câmera).
 *
 * A mesma regra roda aqui, no ETL e no cliente do modelo (repositório ML):
 * acentos saem, e qualquer sequência de espaço, ponto, sublinhado ou outro
 * símbolo vira um hífen. Assim "Caetano Resende", "caetano.resende" e
 * "CAETANO_RESENDE" são o mesmo motorista.
 *
 * O hash compara em minúsculas; o código exibido mantém as maiúsculas que o
 * gestor escolheu ("DRV-1013").
 */

import { sha256 } from "./auth";

export function normalizarId(valor: string): string {
  return valor
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Hash do motorista: o que o dispositivo envia no lugar do ID (LGPD). */
export const hashMotorista = (codigo: string) => sha256(normalizarId(codigo).toLowerCase());

/** ID da câmera como fica gravado: normalizado e em minúsculas. */
export const normalizarDispositivo = (deviceId: string) => normalizarId(deviceId).toLowerCase();

/** Sugestão de código a partir do nome ("João da Silva" -> "joao-da-silva"). */
export const codigoDoNome = (nome: string) => normalizarId(nome).toLowerCase().slice(0, 40).replace(/-+$/, "");
