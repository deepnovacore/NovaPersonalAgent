// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: package names and scoped native phone integration.
package com.nova.phone.core.uistate

import kotlin.math.hypot

/**
 * 用来在新界面里认出「同一个元素」的特征。[context] 是遍历顺序里它前面最近一个有名字的元素,
 * 防止滚动后别处的同名按钮顶上来被误认。[hint]:名字是输入框的提示语/预置词(会轮换);
 * [inList]:元素在列表容器里(列表项会复用,同一位置可能换成别的条目)。
 */
data class ElementLocator(
    val role: String,
    val name: String,
    val resourceId: String?,
    val centerX: Int,
    val centerY: Int,
    val context: String?,
    val hint: Boolean = false,
    val inList: Boolean = false,
)

sealed interface Relocation {
    /** [index] 是新列表里的下标。 */
    data class Found(val index: Int) : Relocation
    /** 还在,但上下文变了或挪得太远。 */
    data object Moved : Relocation
    /** 没名字也没资源 ID,或有好几个一样的。 */
    data object Ambiguous : Relocation
    /** 新界面里没有了。 */
    data object Gone : Relocation
}

/** 找回时允许的最大中心偏移:屏幕短边的这个比例。 */
const val RELOCATE_MAX_SHIFT = 0.15

/** 「还在原地」的偏移上限:屏幕短边的这个比例。 */
const val SAME_SPOT_SHIFT = 0.02

/**
 * 编号过期后在 [after] 里找 [previous] 的唯一对应者。同时满足才算找到:类型、名字、资源 ID 相同,
 * 且在旧列表 [before] 和新列表里都只有这一个;上下文相同;中心挪动不超过短边的 [RELOCATE_MAX_SHIFT]。
 *
 * 页面整体没动(见 [stationary])时再放宽两点,应对轮播、倒计时这类只有局部在变的页面:
 * - 上下文变了但元素还在原地,且不在列表容器里(列表项会复用),照样算找到;
 * - 名字变了,但新旧都有同一个资源 ID、类型相同、还在原地且原地只有它,并且名字只差数字和空白
 *   (「跳过 3」→「跳过 2」),或旧名字是输入框轮换的预置词(hint),也算找到。
 *   「关注」→「已关注」、「下一步」→「确认支付」这类换了含义的不算。
 */
fun relocate(previous: ElementLocator, before: List<ElementLocator>, after: List<ElementLocator>, shortSide: Int): Relocation {
    if (previous.name.isBlank() && previous.resourceId.isNullOrBlank()) return Relocation.Ambiguous
    val spot = shortSide * SAME_SPOT_SHIFT
    val still by lazy { stationary(before, after, spot) }
    fun same(e: ElementLocator) = e.role == previous.role && e.name == previous.name && e.resourceId == previous.resourceId
    val candidates = after.withIndex().filter { same(it.value) }
    if (candidates.isEmpty()) {
        if (previous.resourceId.isNullOrBlank() || !still) return Relocation.Gone
        val inPlace = after.withIndex().filter { (_, e) ->
            e.role == previous.role && e.resourceId == previous.resourceId && shift(e, previous) <= spot
        }
        val found = inPlace.singleOrNull() ?: return Relocation.Gone
        val renamedAlike = previous.hint || stripDigits(found.value.name) == stripDigits(previous.name)
        return if (renamedAlike) Relocation.Found(found.index) else Relocation.Gone
    }
    if (candidates.size > 1 || before.count(::same) > 1) return Relocation.Ambiguous
    val (index, found) = candidates.single()
    val moved = shift(found, previous)
    if (moved > shortSide * RELOCATE_MAX_SHIFT) return Relocation.Moved
    if (found.context != previous.context && !(still && moved <= spot && !previous.inList)) return Relocation.Moved
    return Relocation.Found(index)
}

private fun stripDigits(s: String) = s.filterNot { it.isDigit() || it.isWhitespace() }

private fun shift(a: ElementLocator, b: ElementLocator) =
    hypot((a.centerX - b.centerX).toDouble(), (a.centerY - b.centerY).toDouble())

/**
 * 页面整体没动:前后都唯一出现的有名元素至少 2 个(开屏页这类页面元素很少),其中八成以上还在原地。
 * 列表滚动、换页时大部分元素都挪了或没了,不满足。
 */
internal fun stationary(before: List<ElementLocator>, after: List<ElementLocator>, spot: Double): Boolean {
    fun key(e: ElementLocator) = Triple(e.role, e.name, e.resourceId)
    val afterByKey = after.filter { it.name.isNotBlank() }.groupBy(::key)
    var shared = 0
    var inPlace = 0
    for ((k, list) in before.filter { it.name.isNotBlank() }.groupBy(::key)) {
        val a = afterByKey[k]?.singleOrNull() ?: continue
        if (list.size != 1) continue
        shared++
        if (shift(list[0], a) <= spot) inPlace++
    }
    return shared >= 2 && inPlace >= shared * 0.8
}
