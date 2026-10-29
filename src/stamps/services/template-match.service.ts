import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StampTemplate, StampType } from '../entities/stamp-template.entity';
import { StampTemplateShare } from '../entities/stamp-template-share.entity';
import { User } from '../../users/entities/user.entity';
import { OrderMatchCandidate, OrderMatchDetail } from '../../orders/entities/order.entity';
import { OrderMatchStatus } from '../../orders/enums/order.enum';

export type SkuMatchMode = 'exact' | 'exact_or_suffix';

export interface TemplateMatchResult {
  status: OrderMatchStatus.EXACT | OrderMatchStatus.UNMATCHED | OrderMatchStatus.CONFLICT;
  template?: StampTemplate;
  detail: OrderMatchDetail;
}

/**
 * 印章 / 摇铃共用的 SKU → 模板匹配。
 *
 * 规则（SKU_MATCH_MODE，默认 exact_or_suffix，待甲方确认）：
 * - exact：订单 SKU 与模板 SKU 完全相同
 * - exact_or_suffix：完全相同，或订单 SKU 以「模板 SKU + -」开头（如 WD-204-ZD-black → WD-204-ZD）
 * 完全相同优先于后缀；后缀之间取最长的模板 SKU；最长的有多个模板时为冲突。
 * 不做分词、相似编号或共同前缀的模糊匹配。
 *
 * 大小写和首尾空格：SKU_MATCH_CASE_SENSITIVE=true 时区分大小写，默认不区分；首尾空格总是忽略。
 *
 * 范围：只匹配启用中的模板。普通账号只匹配自己的模板和被授权的模板；
 * 管理员默认匹配所有账号的模板（ADMIN_GLOBAL_SKU_MATCH=false 时也只匹配自己的和被授权的）。
 */
@Injectable()
export class TemplateMatchService {
  private readonly logger = new Logger(TemplateMatchService.name);

  constructor(
    @InjectRepository(StampTemplate)
    private readonly stampTemplateRepository: Repository<StampTemplate>,
    @InjectRepository(StampTemplateShare)
    private readonly shareRepository: Repository<StampTemplateShare>,
  ) {}

  getMode(): SkuMatchMode {
    return process.env.SKU_MATCH_MODE === 'exact' ? 'exact' : 'exact_or_suffix';
  }

  private isCaseSensitive(): boolean {
    return process.env.SKU_MATCH_CASE_SENSITIVE === 'true';
  }

  normalizeSku(value: string | null | undefined): string {
    const trimmed = String(value ?? '').trim();
    return this.isCaseSensitive() ? trimmed : trimmed.toLowerCase();
  }

  describeRule(): string {
    const mode = this.getMode() === 'exact' ? '完全相同' : '完全相同或模板SKU+连字符后缀';
    const caseRule = this.isCaseSensitive() ? '区分大小写' : '不区分大小写';
    return `${mode}；${caseRule}`;
  }

  /** 当前账号可用于匹配和手动选择的模板（不含停用和已删除的） */
  async getTemplatesInScope(user?: User | null, options?: { includeInactive?: boolean }): Promise<StampTemplate[]> {
    const qb = this.stampTemplateRepository.createQueryBuilder('template');
    if (!options?.includeInactive) {
      qb.where('template.isActive = true');
    }
    const adminGlobal = process.env.ADMIN_GLOBAL_SKU_MATCH !== 'false';
    if (user && !(user.isAdmin && adminGlobal)) {
      qb.andWhere(
        `(template.userId = :userId OR template.id IN (
          SELECT share."templateId" FROM stamp_template_shares share WHERE share."granteeUserId" = :userId
        ))`,
        { userId: user.id },
      );
    }
    return qb.getMany();
  }

  /** 在给定模板集合中按规则匹配，不访问数据库，便于批量审计 */
  matchAgainst(sku: string, templates: StampTemplate[]): TemplateMatchResult {
    const orderSku = String(sku ?? '').trim();
    const normalizedOrderSku = this.normalizeSku(orderSku);
    const rule = this.describeRule();
    const matchedAt = new Date().toISOString();

    if (!normalizedOrderSku) {
      return {
        status: OrderMatchStatus.UNMATCHED,
        detail: { rule, orderSku, reason: '订单没有 SKU', matchedAt },
      };
    }

    const allowSuffix = this.getMode() === 'exact_or_suffix';
    // 每个模板只保留它得分最高的 SKU；完全相同得分高于任何后缀匹配
    const best = new Map<number, { template: StampTemplate; alias: string; score: number }>();

    for (const template of templates) {
      for (const aliasRaw of template.skus || []) {
        const alias = this.normalizeSku(aliasRaw);
        if (!alias) continue;
        let score = -1;
        if (alias === normalizedOrderSku) {
          score = 100000 + alias.length;
        } else if (allowSuffix && normalizedOrderSku.startsWith(`${alias}-`)) {
          score = alias.length;
        }
        if (score < 0) continue;
        const current = best.get(template.id);
        if (!current || score > current.score) {
          best.set(template.id, { template, alias: aliasRaw.trim(), score });
        }
      }
    }

    if (best.size === 0) {
      return {
        status: OrderMatchStatus.UNMATCHED,
        detail: { rule, orderSku, reason: '没有模板的 SKU 符合匹配规则', matchedAt },
      };
    }

    const topScore = Math.max(...Array.from(best.values()).map(item => item.score));
    const top = Array.from(best.values()).filter(item => item.score === topScore);
    const candidates: OrderMatchCandidate[] = top.map(item => ({
      templateId: item.template.id,
      templateName: item.template.name,
      matchedSku: item.alias,
    }));

    if (top.length > 1) {
      const allMultiRattle = top.every(
        item => item.template.type === StampType.RATTLE && item.template.allowMultipleForSku,
      );
      return {
        status: OrderMatchStatus.CONFLICT,
        detail: {
          rule,
          orderSku,
          candidates,
          reason: allMultiRattle ? 'multi_template' : '多个模板同样符合规则',
          matchedAt,
        },
      };
    }

    return {
      status: OrderMatchStatus.EXACT,
      template: top[0].template,
      detail: { rule, orderSku, matchedSku: top[0].alias, candidates, matchedAt },
    };
  }

  async match(sku: string, user?: User | null): Promise<TemplateMatchResult> {
    const templates = await this.getTemplatesInScope(user);
    const result = this.matchAgainst(sku, templates);
    this.logger.log(
      `SKU ${sku} → ${result.status}${result.template ? ` (#${result.template.id} ${result.detail.matchedSku})` : ''}`,
    );
    return result;
  }

  /** 用户能否使用该模板（自己的、被授权的，或管理员） */
  async canUseTemplate(template: StampTemplate, user: User): Promise<boolean> {
    if (user.isAdmin || template.userId === user.id) return true;
    const share = await this.shareRepository.findOne({
      where: { templateId: template.id, granteeUserId: user.id as string },
    });
    return !!share;
  }
}
