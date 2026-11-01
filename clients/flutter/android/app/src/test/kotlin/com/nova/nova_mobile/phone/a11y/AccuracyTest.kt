// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: relocation tests using the shared phone-core implementation.
// copy; typeAndVerify tests are not copied (Nova does not port typeAndVerify).
package com.nova.nova_mobile.phone.a11y

import com.nova.phone.core.uistate.ElementLocator
import com.nova.phone.core.uistate.Relocation
import com.nova.phone.core.uistate.relocate

import org.junit.Assert.assertEquals
import org.junit.Test

class AccuracyTest {
    private fun loc(
        name: String, x: Int = 100, y: Int = 100, ctx: String? = "上一项", role: String = "TextView", rid: String? = null,
        hint: Boolean = false, inList: Boolean = false,
    ) = ElementLocator(role, name, rid, x, y, ctx, hint, inList)

    @Test fun findsSameElementAfterSmallShift() {
        val prev = loc("蓝牙")
        val after = listOf(loc("WLAN", ctx = null), loc("蓝牙", y = 150))
        assertEquals(Relocation.Found(1), relocate(prev, listOf(prev), after, 720))
    }

    @Test fun goneWhenNotInNewList() {
        assertEquals(Relocation.Gone, relocate(loc("蓝牙"), listOf(loc("蓝牙")), listOf(loc("WLAN")), 720))
    }

    @Test fun ambiguousWhenDuplicatedOrNameless() {
        val prev = loc("删除")
        assertEquals(Relocation.Ambiguous, relocate(prev, listOf(prev), listOf(prev, prev.copy(centerY = 300)), 720))
        assertEquals(Relocation.Ambiguous, relocate(prev, listOf(prev, prev.copy(centerY = 300)), listOf(prev), 720))
        assertEquals(Relocation.Ambiguous, relocate(loc(""), listOf(loc("")), listOf(loc("")), 720))
    }

    @Test fun namelessWithResourceIdCanBeFound() {
        val prev = loc("", rid = "com.x:id/cart")
        assertEquals(Relocation.Found(0), relocate(prev, listOf(prev), listOf(prev.copy(centerX = 120)), 720))
    }

    @Test fun movedWhenContextChangesOrShiftTooFar() {
        val prev = loc("加入购物车", ctx = "商品 A")
        assertEquals(Relocation.Moved, relocate(prev, listOf(prev), listOf(prev.copy(context = "商品 B")), 720))
        // 0.15 × 720 = 108px
        assertEquals(Relocation.Moved, relocate(prev, listOf(prev), listOf(prev.copy(centerY = 100 + 109)), 720))
        assertEquals(Relocation.Found(0), relocate(prev, listOf(prev), listOf(prev.copy(centerY = 100 + 108)), 720))
    }

    // 页面其余部分不动(底栏三项),只有目标自己在变:倒计时、轮播的预置词、轮播导致的上下文变化
    private val tabs = listOf(loc("首页", 100, 1500, null), loc("消息", 360, 1500, "首页"), loc("我的", 620, 1500, "消息"))

    @Test fun sameSpotFoundWhenOnlyItsTextChangedOnAStillPage() {
        val prev = loc("跳过 3", 600, 50, ctx = "广告", role = "Button", rid = "com.x:id/skip")
        val after = tabs + prev.copy(name = "跳过 2")
        assertEquals(Relocation.Found(3), relocate(prev, tabs + prev, after, 720))
    }

    @Test fun countdownOnASparseSplashPageIsFound() {
        // 开屏广告页只有寥寥几个有名元素
        val prev = loc("跳过 3", 600, 50, ctx = null, role = "TextView", rid = "com.x:id/skip")
        val rest = listOf(loc("广告", 600, 1500, "跳过 3"), loc("浏览器", 360, 1550, "广告"))
        assertEquals(Relocation.Found(0), relocate(prev, listOf(prev) + rest, listOf(prev.copy(name = "跳过 2")) + rest, 720))
    }

    @Test fun rotatingPlaceholderInSearchBarIsFound() {
        val prev = loc("宝安租房", 360, 200, ctx = "定位", role = "EditText", rid = "com.x:id/search_bar", hint = true)
        val after = tabs + prev.copy(name = "平板电脑")
        assertEquals(Relocation.Found(3), relocate(prev, tabs + prev, after, 720))
    }

    @Test fun differentControlInTheSameSpotIsNeverTaken() {
        // 名字变了、去掉数字和空白后也对不上:是另一个控件(或同一控件换了含义),不能替模型点
        val follow = loc("关注", 600, 300, role = "Button", rid = "com.x:id/follow")
        assertEquals(Relocation.Gone, relocate(follow, tabs + follow, tabs + follow.copy(name = "已关注"), 720))
        val next = loc("下一步", 360, 1300, role = "Button", rid = "com.x:id/primary")
        assertEquals(Relocation.Gone, relocate(next, tabs + next, tabs + next.copy(name = "确认支付"), 720))
        // 没有资源 ID 时连倒计时也不放宽
        val skip = loc("跳过 3", 600, 50, role = "Button")
        assertEquals(Relocation.Gone, relocate(skip, tabs + skip, tabs + skip.copy(name = "跳过 2"), 720))
        // 新旧任一方没有资源 ID 也不放宽
        val skipRid = skip.copy(resourceId = "com.x:id/skip")
        assertEquals(Relocation.Gone, relocate(skipRid, tabs + skipRid, tabs + skip.copy(name = "跳过 2"), 720))
        // 不是提示语的普通文字换了也不算
        val plain = loc("宝安租房", 360, 200, role = "TextView", rid = "com.x:id/title")
        assertEquals(Relocation.Gone, relocate(plain, tabs + plain, tabs + plain.copy(name = "平板电脑"), 720))
    }

    @Test fun contextChangeInsideAListIsNotRelaxed() {
        val prev = loc("购买", 360, 200, ctx = "商品 A", role = "Button", inList = true)
        assertEquals(Relocation.Moved, relocate(prev, tabs + prev, tabs + prev.copy(context = "商品 B"), 720))
    }

    @Test fun contextChangedByCarouselOnAStillPageIsFound() {
        val prev = loc("搜索", 360, 200, ctx = "轮播图 A", role = "Button")
        val after = tabs + prev.copy(context = "轮播图 B")
        assertEquals(Relocation.Found(3), relocate(prev, tabs + prev, after, 720))
    }

    @Test fun sameSpotNotTrustedWhenThePageScrolledOrChanged() {
        val prev = loc("加入购物车", 360, 400, ctx = "商品 A", role = "Button")
        val rows = listOf(loc("商品 A", 100, 300, null), loc("商品 B", 100, 500, "商品 A"), loc("商品 C", 100, 700, "商品 B"))
        // 列表上移一行:别的商品的按钮刚好挪到原位置
        val scrolled = rows.map { it.copy(centerY = it.centerY - 200) } + prev.copy(context = "商品 B")
        assertEquals(Relocation.Moved, relocate(prev, rows + prev, scrolled, 720))
        // 换了一页:同位置的按钮名字也变了
        val otherPage = listOf(loc("设置", 100, 300, null), loc("关于", 100, 500, "设置"), prev.copy(name = "退出登录"))
        assertEquals(Relocation.Gone, relocate(prev, rows + prev, otherPage, 720))
    }
}
