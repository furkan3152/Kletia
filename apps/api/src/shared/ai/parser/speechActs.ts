/**
 * Speech-act checks: approval-bound planning requests, non-execution
 * wording and explicit transaction negation.
 */

/**
 * A positive financial instruction may also describe the wallet-approval
 * boundary. That is a request to prepare a reviewable route, not a request to
 * suppress planning altogether. Execution still remains impossible without
 * the normal simulation and wallet-signature gates.
 */
function hasApprovalBoundPlanningRequest(prompt: string): boolean {
  const normalized = prompt
    .trim()
    .toLowerCase()
    .replace(/\u0307/gu, "");
  if (!normalized) return false;

  const positiveInstruction =
    /^(?:swap|stake|unstake|lend|supply|deposit|withdraw|borrow|repay|bridge|transfer|send|pay|buy|sell|convert|add\s+liquidity|remove\s+liquidity|call|find|discover|prepare|create|atomically\s+pay|takasla|çevir|cevir|yatır|yatir|çek|cek|borçlan|borclan|gönder|gonder|öde|ode|satın\s+al|satin\s+al)\b/iu.test(
      normalized,
    );
  if (!positiveInstruction) return false;

  return (
    /\b(?:before|prior\s+to)\s+(?:(?:my|wallet|user|the\s+user['’]?s)\s+)?(?:approval|signature|execution)\b/iu.test(
      normalized,
    ) ||
    /\b(?:do\s+not|don['’]?t|must\s+not)\s+(?:execute|submit|broadcast|send|pay)\b[^,;:.!?\n]{0,120}\b(?:until|unless)\s+(?:i|the\s+user)\s+(?:explicitly\s+)?approve\b/iu.test(
      normalized,
    )
  );
}

export function hasNonExecutionSpeechAct(prompt: string): boolean {
  const normalized = prompt
    .trim()
    .toLowerCase()
    .replace(/\u0307/gu, "");
  if (!normalized) return false;
  if (hasApprovalBoundPlanningRequest(prompt)) return false;
  if (
    /\b(?:portfolio|portföy|portfoy)\b/iu.test(normalized) &&
    /\bwithout\s+(?:sending|submitting|broadcasting)\s+(?:a\s+)?transaction\b/iu.test(
      normalized,
    )
  ) {
    return false;
  }
  // Borrow-capacity is an explicitly read-only product action. It still goes
  // through network, asset, wallet and live Aave-state binding, but wording
  // such as "without sending a transaction" must not demote it to chat.
  if (
    /(?:\b(?:how\s+much|maximum|max|capacity|available|safe(?:ly)?)\b[^,;:.!?\n]{0,80}\b(?:borrow|loan)\b|\b(?:borrow|loan)\b[^,;:.!?\n]{0,80}\b(?:capacity|maximum|max|available|safe(?:ly)?))\b/iu.test(
      normalized,
    )
  ) {
    return false;
  }
  const explicitFinalExecution =
    /(?:^|[,;:.!?]\s*|\b(?:but|however|instead|now|then|ama|ancak|şimdi|simdi)\s+)(?:actually\s+)?(?:execute|submit|broadcast|proceed|do\s+it|go\s+ahead(?:\s+and)?|prepare\s+(?:the\s+)?(?:transaction|route)|işlemi\s+(?:hazırla|hazirla|çalıştır|calistir|gerçekleştir|gerceklestir)|rotayı\s+(?:hazırla|hazirla)|devam\s+et)\s*[.!?]*$/iu.test(
      normalized,
    );
  if (explicitFinalExecution) return false;

  const explicitlyReadOnly =
    /\b(?:quote|preview|simulation|simulate|estimate|example)\s+only\b|\b(?:simulate|preview|estimate)\b[^,;:.!?\n]{0,120}\bonly\b|\bonly\s+(?:quote|preview|simulate|estimate)\b|\bjust\s+(?:quote|preview|simulate|estimate|explain)\b|\b(?:without|with\s+no)\s+(?:executing|execution|submitting|submission|broadcasting|sending\s+(?:a\s+)?transaction|swapping|trading|buying|selling|staking|lending|borrowing)\b|\bdo\s+not\s+(?:actually\s+)?(?:execute|submit|broadcast)(?:\s+(?:it|that|this))?(?:\s+yet)?\b|\bnot\s+asking\s+(?:you\s+)?to\b|\b(?:sadece|yalnızca|yalnizca)\s+(?:teklif|önizleme|onizleme|simülasyon|simulasyon|açıklama|aciklama)\b|\b(?:gerçekleştirmeden|gerceklestirmeden|göndermeden|gondermeden)\b|\b(?:henüz|henuz)\s+(?:gerçekleştirme|gerceklestirme|gönderme|gonderme|yapma)\b/iu.test(
      normalized,
    );
  const informational =
    /^(?:show\s+me\s+how|how\s+(?:do|can|would)\s+i|could\s+you\s+(?:explain|show|tell)|can\s+you\s+explain|explain\s+(?:how|what)|tell\s+me\s+how|what\s+(?:happens|would\s+happen|is\s+the\s+result)\s+if|what\s+if|[iı]\s+(?:am|was)\s+wondering\s+(?:what|how)|show\s+me\s+an?\s+example|give\s+me\s+an?\s+example)\b/iu.test(
      normalized,
    ) ||
    /\b(?:example|örnek|ornek)\s+please\s*[.!?]*$/iu.test(normalized) ||
    /^(?:nasıl|nasil)\s+.+\b(?:yapılır|yapilir|olur)\b/iu.test(normalized) ||
    /\b(?:nasıl\s+yapılır|nasil\s+yapilir|yaparsam\s+ne\s+olur|örnek\s+(?:göster|ver)|ornek\s+(?:goster|ver)|nasıl\s+çalıştığını\s+açıkla|nasil\s+calistigini\s+acikla)\b/iu.test(
      normalized,
    );
  const hypothetical =
    /^(?:suppose|supposing|imagine|assuming|what\s+if|maybe|perhaps)\b|\b[iı]\s+(?:might|may)\b|\b[iı]\s+(?:am|was)\s+(?:considering|thinking\s+about)\b|^(?:belki|varsayalım|varsayalim|farz\s+edelim)\b/iu.test(
      normalized,
    );

  return explicitlyReadOnly || informational || hypothetical;
}

export function hasExplicitTransactionNegation(prompt: string): boolean {
  const lower = prompt
    .trim()
    .toLowerCase()
    .replace(/\u0307/gu, "");
  if (!lower) return false;
  if (hasApprovalBoundPlanningRequest(prompt)) return false;
  if (
    /\b(?:portfolio|portföy|portfoy)\b/iu.test(lower) &&
    /\bwithout\s+(?:sending|submitting|broadcasting)\s+(?:a\s+)?transaction\b/iu.test(
      lower,
    )
  ) {
    return false;
  }

  if (
    /^(?:no(?:\s+(?:thanks|thank\s+you))?|cancel|stop|don['’]?t|never\s+mind|forget\s+(?:it|that)|hayır(?:\s+teşekkürler)?|hayir(?:\s+tesekkurler)?|yapma|etme|iptal|boşver|bosver|vazgeç|vazgec|vazgeçtim|vazgectim)[.!?]?$/iu.test(
      lower,
    )
  ) {
    return true;
  }

  const englishAction =
    "(?:swapp?ing|swapped|swap|converting|converted|convert|trading|traded|trade|buying|bought|buy|selling|sold|sell|lending|lent|lend|supplying|supplied|supply|depositing|deposited|deposit|borrowing|borrowed|borrow|repaying|repaid|repay|withdrawing|withdrawn|withdraw|staking|staked|stake|unstaking|unstaked|unstake|bridging|bridged|bridge|registering|registered|register|renewing|renewed|renew|sending|sent|send|paying|paid|pay|adding liquidity|add liquidity|removing liquidity|remove liquidity)";
  const directlyNegatedEnglishAction = new RegExp(
    `\\b(?:do\\s+not|don['’]?t|won['’]?t|will\\s+not|would\\s+not|` +
      `must\\s+not|should\\s+not|never(?:\\s+ever)?|` +
      `would\\s+rather\\s+not|rather\\s+not|never)\\s+` +
      `(?:(?:execute|submit|prepare|broadcast)\\s+(?:an?\\s+|the\\s+)?)?` +
      `${englishAction}\\b`,
    "iu",
  );
  const rejectedEnglishAction = new RegExp(
    `\\b(?:` +
      `(?:do\\s+not|don['’]?t)\\s+(?:want|intend|plan)\\b` +
      `[^,;:.!?\\n]{0,100}\\b${englishAction}|` +
      `(?:do\\s+not|don['’]?t|won['’]?t|will\\s+not)\\s+` +
      `(?:execute|submit|prepare|broadcast)\\b` +
      `[^,;:.!?\\n]{0,100}\\b${englishAction}|` +
      `(?:am\\s+|is\\s+|are\\s+)?not\\s+going\\s+to\\s+${englishAction}|` +
      `(?:have\\s+|has\\s+)?decided\\s+not\\s+to\\s+${englishAction}|` +
      `(?:refuse|decline)\\s+to\\s+${englishAction}|` +
      `refrain\\s+from\\s+${englishAction}|` +
      `avoid\\s+${englishAction}|` +
      `not\\s+asking\\s+(?:you\\s+)?to\\s+${englishAction}|` +
      `without\\s+${englishAction}|` +
      `(?:do\\s+everything|anything)\\s+except\\s+${englishAction}|` +
      `under\\s+no\\s+circumstances\\b[^,;:.!?\\n]{0,100}\\b${englishAction}|` +
      `(?:cancel|stop|skip)\\s+(?:(?:the|this|that)\\s+)?${englishAction}|` +
      `[iı]\s+changed\s+my\s+mind\s+about\s+${englishAction}` +
      `)\\b`,
    "iu",
  );
  if (
    directlyNegatedEnglishAction.test(lower) ||
    rejectedEnglishAction.test(lower)
  ) {
    return true;
  }

  const transactionSignal =
    /(?:^|[^\p{L}\p{N}_])(?:swap|stake|unstake|lend|borrow|bridge|takas|likidite|borç|kredi|ödeme|transfer|yatır|çek|kaydet|yenile|uzat|çevir|cevir|al|sat)(?=$|[^\p{L}\p{N}_])|satın\s+al/iu;
  const containsTransactionAction =
    transactionSignal.test(lower) ||
    new RegExp(`\\b${englishAction}\\b`, "iu").test(lower);
  const hasTrailingCancellation =
    /(?:^|[,;:.!?–—-]\s*|\bbut\s+|\bama\s+)(?:actually\s+)?(?:[iı]\s+(?:(?:do\s+not|don['’]?t)\s+want\s+(?:you\s+)?to\s+do\s+(?:it|that|this)|refuse|decline)|no(?:\s+(?:thanks|thank\s+you))?|(?:please\s+)?(?:do\s+not|don['’]?t)(?:\s+(?:actually\s+)?(?:execute|do|send|submit|broadcast)(?:\s+(?:it|that|this))?)?(?:\s+yet)?|not\s+(?:now|anymore)|cancel(?:\s+(?:that|it|this))?|stop(?:\s+(?:that|it|this))?|skip(?:\s+(?:that|it|this))?|never\s+mind|forget\s+(?:about\s+)?(?:it|that|this)|disregard\s+(?:it|that|this)|[iı]\s+changed\s+my\s+mind|hayır(?:\s+teşekkürler)?|hayir(?:\s+tesekkurler)?|iptal(?:\s+et)?|boşver|bosver|vazgeç|vazgec|(?:henüz|henuz)\s+(?:gerçekleştirme|gerceklestirme|gönderme|gonderme|yapma)|yapma|etme)\s*[.!?]*$/iu.test(
      lower,
    );
  if (containsTransactionAction && hasTrailingCancellation) {
    return true;
  }
  if (
    /^(?:no|hayır|hayir)\b[\s,;:!.–—-]+/iu.test(lower) &&
    containsTransactionAction
  ) {
    return true;
  }
  if (
    transactionSignal.test(lower) &&
    /\b(?:istemiyorum|istemiyoruz|vazgeçtim|vazgectim|iptal\s+et)\b/iu.test(
      lower,
    )
  ) {
    return true;
  }

  return (
    /\b(?:swap|stake|unstake|lend|borrow|bridge|takas|transfer|register|renew)\s+(?:yapma|etme)\b/iu.test(
      lower,
    ) ||
    /\blikidite\s+(?:ekleme|çıkarma|cikarma|çekme)\b/iu.test(lower) ||
    /\bborç\s+(?:alma|verme|ödeme)\b(?:\s+(?:sakın|sakin|lütfen|lutfen))?(?:[.!]|$)/iu.test(
      lower,
    ) ||
    /\b(?:satın\s+alma|alma|satma)\b/iu.test(lower) ||
    /(?:^|[^\p{L}\p{N}_])(?:swapla|takasla|çevir|cevir|al|sat|stake|unstake|bridge|gönder|gonder|yatır|yatir|çek|cek|borçlan|borclan|ekle|çıkar|cikar)(?:ma|me|mayalım|meyelim|mayalim|meyelim|mayın|meyin|mayin|masın|mesin|masin)(?=$|[^\p{L}\p{N}_])/iu.test(
      lower,
    ) ||
    /\b(?:yatırma|yatirma|çekme|cekme|ödeme|odeme|gönderme|gonderme|kaydetme|yenileme|uzatma)\b(?:\s+(?:sakın|sakin|lütfen|lutfen))?(?:[.!]|$)/iu.test(
      lower,
    ) ||
    /(?:^|[^\p{L}\p{N}_])(?:almak|satmak|swaplamak|takaslamak|çevirmek|cevirmek|stake\s+etmek|unstake\s+etmek|borçlanmak|borclanmak|borç\s+almak|borc\s+almak|yatırmak|yatirmak|çekmek|cekmek|göndermek|gondermek|ödemek|odemek|kaydetmek|yenilemek|uzatmak)\s+istem(?:iyorum|iyoruz)(?=$|[^\p{L}\p{N}_])/iu.test(
      lower,
    ) ||
    /(?:^|[^\p{L}\p{N}_])(?:çevril|cevril|swaplan|takaslan)(?:me|ma|mesin|masın|masin|meyelim|mayalım|mayalim|meyin|mayın|mayin)(?=$|[^\p{L}\p{N}_])/iu.test(
      lower,
    )
  );
}
