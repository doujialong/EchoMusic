import { defineStore } from 'pinia';
import { claimDayVip, upgradeDayVip } from '@/api/user';
import request from '@/utils/request';
import { useUserStore } from './user';

type Attempt = { day: string; time: number; count: number; done: boolean; message: string };
export const claimDay = (now = Date.now()) =>
  new Date(now + 8 * 3600000).toISOString().slice(0, 10);

export const useVipClaimStore = defineStore('vipClaim', {
  state: () => ({
    enabled: true,
    busy: false,
    attempts: {} as Record<string, Attempt>,
  }),
  actions: {
    async claim(manual = false) {
      const user = useUserStore();
      const id = String(user.info?.userid || '');
      if (!user.isLoggedIn || !id || this.busy) return;
      if (!manual && !this.enabled) return;
      const now = Date.now();
      const day = claimDay(now);
      const previous = this.attempts[id];
      if (previous && previous.day === day) {
        if (now - previous.time < (manual ? 60000 : 1800000)) return;
        if (!manual && (previous.done || previous.count >= 3)) return;
      }
      const attempt: Attempt = {
        day, time: now,
        count: previous?.day === day ? previous.count + 1 : 1,
        done: false, message: '正在领取…',
      };
      this.attempts[id] = attempt;
      this.busy = true;
      const sameAccount = () => user.isLoggedIn && String(user.info?.userid) === id;
      const results: string[] = [];
      let accepted = true;
      try {
        let receiveDay = day;
        try {
          const clock = await request.get('/server/now', { skipKugouVerification: !manual }) as Record<string, any>;
          const source = clock?.data && typeof clock.data === 'object' ? clock.data : clock;
          for (const key of ['now', 'time', 'timestamp', 'server_time', 'serverTime']) {
            const value = Number(source?.[key]);
            const ms = value > 1e12 ? value : value * 1000;
            if (Number.isFinite(ms) && ms > 946684800000 && ms < 4102444800000) {
              receiveDay = claimDay(ms);
              break;
            }
          }
        } catch { /* Fall back to the local clock, still formatted in Beijing time. */ }
        const steps: Array<[string, () => Promise<unknown>]> = [
          ['每日畅听会员', () => claimDayVip(receiveDay, !manual)],
          ['概念会员升级', () => upgradeDayVip(!manual)],
          ['关联会员权益', () => request.get('/youth/union/vip', { skipKugouVerification: !manual })],
        ];
        for (const [name, run] of steps) {
          if (!sameAccount()) return;
          try {
            const response = await run();
            const body = response as { status?: number; error_code?: number } | null;
            if (body?.status === 1) results.push(`${name}：接口已受理`);
            else {
              accepted = false;
              results.push(`${name}：未领取成功（错误码 ${body?.error_code ?? '未知'}）`);
            }
          } catch (error) {
            const body = (error as { response?: { body?: { error_code?: number } } })?.response?.body;
            const businessCode = Number(body?.error_code);
            if (name === '概念会员升级' && businessCode === 297002) {
              // Observed platform response: 已经领取过升级vip奖励.
              results.push(`${name}：平台确认已领取过`);
            } else {
              accepted = false;
              const code = error instanceof Error ? error.message.match(/API Error:\s*(\d+)/)?.[1] : undefined;
              results.push(Number.isFinite(businessCode)
                ? `${name}：平台未发放（错误码 ${businessCode}），请在官方 App 核对`
                : `${name}：请求失败${code ? `（HTTP ${code}）` : ''}，请稍后重试`);
            }
          }
        }
        if (!sameAccount()) return;
        const refreshed = await user.fetchUserInfo();
        this.attempts[id].done = accepted && refreshed === true;
        this.attempts[id].message = results.join('；') +
          (refreshed ? '。已刷新会员状态，请在个人主页核对到期时间。' : '。会员状态刷新失败，请稍后重试。');
      } finally {
        if (!sameAccount()) this.attempts[id].message = '账号已切换，领取流程已停止。';
        this.busy = false;
      }
    },
  },
  persist: { omit: ['busy'] },
});
