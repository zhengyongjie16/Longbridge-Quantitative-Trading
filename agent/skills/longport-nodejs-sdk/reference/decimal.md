# Decimal 类与日期类型

SDK 使用 `Decimal` 类型处理所有价格和金额，避免浮点精度问题。

## 创建 Decimal

```typescript
const d = new Decimal("50.5");      // 从字符串创建（推荐）
const d = new Decimal(50.5);        // 从数字创建
const d = Decimal.newWithScale(505, 1); // 从整数+小数位创建 => 50.5
```

## 静态常量

```typescript
Decimal.ZERO()           // 0
Decimal.ONE()            // 1
Decimal.TWO()            // 2
Decimal.TEN()            // 10
Decimal.ONE_HUNDRED()    // 100
Decimal.ONE_THOUSAND()   // 1000
Decimal.NEGATIVE_ONE()   // -1
Decimal.MAX()            // 最大值
Decimal.MIN()            // 最小值
Decimal.PI()             // π
Decimal.HALF_PI()        // π/2
Decimal.QUARTER_PI()     // π/4
Decimal.TWO_PI()         // 2π
Decimal.E()              // e
Decimal.E_INVERSE()      // 1/e
```

## 转换方法

```typescript
d.toString(): string     // 转为字符串
d.toNumber(): number     // 转为数字
d.toJSON(): any          // JSON 序列化
```

## 数学运算

```typescript
d.add(other: Decimal): Decimal     // 加法 +
d.sub(other: Decimal): Decimal     // 减法 -
d.mul(other: Decimal): Decimal     // 乘法 *
d.div(other: Decimal): Decimal     // 除法 /
d.rem(other: Decimal): Decimal     // 取余 %
d.neg(): Decimal                   // 取反 -x
d.abs(): Decimal                   // 绝对值
d.ceil(): Decimal                  // 向上取整
d.floor(): Decimal                 // 向下取整
d.round(): Decimal                 // 四舍五入（银行家舍入：6.5→6, 7.5→8）
d.roundDp(dp: number): Decimal    // 保留指定小数位（银行家舍入）
d.trunc(): Decimal                 // 截断小数
d.fract(): Decimal                 // 小数部分
d.normalize(): Decimal             // 去除末尾零，-0 转 0
d.sqrt(): Decimal                  // 平方根
d.pow(exp: Decimal): Decimal       // 幂运算
d.ln(): Decimal                    // 自然对数
d.log10(): Decimal                 // 常用对数
d.exp(): Decimal                   // e^x
d.expWithTolerance(t: Decimal): Decimal // e^x（自定义精度）
d.sin(): Decimal                   // 正弦
d.cos(): Decimal                   // 余弦
d.tan(): Decimal                   // 正切
d.erf(): Decimal                   // 误差函数
d.normCdf(): Decimal               // 正态分布累积函数
d.normPdf(): Decimal               // 正态分布概率密度函数
```

## 比较方法

```typescript
d.greaterThan(other: Decimal): boolean         // >
d.greaterThanOrEqualTo(other: Decimal): boolean // >=
d.lessThan(other: Decimal): boolean            // <
d.lessThanOrEqualTo(other: Decimal): boolean   // <=
d.equals(other: Decimal): boolean              // ==
d.comparedTo(other: Decimal): number           // -1 / 0 / 1
d.isZero(): boolean                            // 是否为零
d.isPositive(): boolean                        // 是否为正
d.isNegative(): boolean                        // 是否为负
d.max(other: Decimal): Decimal                 // 取最大值
d.min(other: Decimal): Decimal                 // 取最小值
```

---

## NaiveDate（日期）

```typescript
const date = new NaiveDate(2023, 1, 20); // 年, 月, 日
date.year: number    // 年
date.month: number   // 月
date.day: number     // 日
date.toString(): string
date.toJSON(): any
```

## NaiveDatetime（日期时间）

```typescript
const dt = new NaiveDatetime(2023, 1, 20, 10, 30, 0); // 年, 月, 日, 时, 分, 秒
```
