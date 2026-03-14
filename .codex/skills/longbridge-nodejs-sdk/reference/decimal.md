# Decimal / NaiveDate / NaiveDatetime / Time

Official sources:

- https://longbridge.github.io/openapi/nodejs/classes/Decimal.html
- https://longbridge.github.io/openapi/nodejs/classes/NaiveDate.html
- https://longbridge.github.io/openapi/nodejs/classes/NaiveDatetime.html
- https://longbridge.github.io/openapi/nodejs/classes/Time.html

## Decimal

### Constructor

```ts
new Decimal(value: string | number)
```

### Static methods

```ts
Decimal.E(): Decimal
Decimal.E_INVERSE(): Decimal
Decimal.HALF_PI(): Decimal
Decimal.MAX(): Decimal
Decimal.MIN(): Decimal
Decimal.NEGATIVE_ONE(): Decimal
Decimal.ONE(): Decimal
Decimal.ONE_HUNDRED(): Decimal
Decimal.ONE_THOUSAND(): Decimal
Decimal.PI(): Decimal
Decimal.QUARTER_PI(): Decimal
Decimal.TEN(): Decimal
Decimal.TWO(): Decimal
Decimal.TWO_PI(): Decimal
Decimal.ZERO(): Decimal
Decimal.newWithScale(num: number, scale: number): Decimal
```

### Instance methods

```ts
toString(): string
toNumber(): number
toJSON(): any

abs(): Decimal
ceil(): Decimal
floor(): Decimal
fract(): Decimal
isNegative(): boolean
isPositive(): boolean
isZero(): boolean
max(other: Decimal): Decimal
min(other: Decimal): Decimal
normalize(): Decimal
round(): Decimal
roundDp(dp: number): Decimal
trunc(): Decimal

add(other: Decimal): Decimal
sub(other: Decimal): Decimal
mul(other: Decimal): Decimal
div(other: Decimal): Decimal
rem(other: Decimal): Decimal
neg(): Decimal

greaterThan(other: Decimal): boolean
greaterThanOrEqualTo(other: Decimal): boolean
equals(other: Decimal): boolean
lessThan(other: Decimal): boolean
lessThanOrEqualTo(other: Decimal): boolean
comparedTo(other: Decimal): number

sin(): Decimal
cos(): Decimal
tan(): Decimal
sqrt(): Decimal
pow(exp: Decimal): Decimal
ln(): Decimal
log10(): Decimal
exp(): Decimal
expWithTolerance(tolerance: Decimal): Decimal
erf(): Decimal
normCdf(): Decimal
normPdf(): Decimal
```

### Example

```ts
const price = new Decimal('50.5');
const qty = Decimal.newWithScale(1250, 2); // 12.50
const value = price.mul(qty);
console.log(value.toString());
```

## NaiveDate

### Constructor

```ts
new NaiveDate(year: number, month: number, day: number)
```

### Accessors and methods

```ts
get year(): number
get month(): number
get day(): number
toString(): string
toJSON(): any
```

### Example

```ts
const d = new NaiveDate(2026, 3, 15);
console.log(d.toString());
```

## NaiveDatetime

### Constructor

```ts
new NaiveDatetime(date: NaiveDate, time: Time)
```

### Accessors and methods

```ts
get date(): NaiveDate
get time(): Time
toString(): string
toJSON(): any
```

### Example

```ts
const dt = new NaiveDatetime(new NaiveDate(2026, 3, 15), new Time(9, 30, 0));
console.log(dt.toString());
```

## Time

### Constructor

```ts
new Time(hour: number, minute: number, second: number)
```

### Accessors and methods

```ts
get hour(): number
get monute(): number
get toString(): string
toJSON(): any
```

### Example

```ts
const sessionOpen = new Time(9, 30, 0);
console.log(sessionOpen.toString);
```