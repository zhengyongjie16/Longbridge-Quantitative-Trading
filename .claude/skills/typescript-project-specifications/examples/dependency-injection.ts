/**
 * 依赖注入模式示例
 *
 * 本示例展示如何正确实现依赖注入，遵循以下原则：
 * 1. 所有依赖通过参数注入，永远不在内部创建
 * 2. 使用接口定义依赖契约
 * 3. 便于测试和替换实现
 * 4. 避免硬编码依赖
 */

// ============================================================================
// 类型定义
// ============================================================================

export type User = {
  readonly id: string;
  readonly email: string;
  readonly name: string;
};

export type AuthToken = {
  readonly token: string;
  readonly expiresAt: Date;
};

export type LoginCredentials = {
  readonly email: string;
  readonly password: string;
};

// ============================================================================
// 依赖接口定义（契约）
// ============================================================================

/**
 * 用户仓储接口
 */
export interface UserRepository {
  findByEmail(email: string): Promise<User | null>;
  save(user: User): Promise<void>;
}

/**
 * 密码哈希服务接口
 */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

/**
 * Token 生成器接口
 */
export interface TokenGenerator {
  generate(userId: string): Promise<AuthToken>;
  verify(token: string): Promise<string | null>;
}

/**
 * 日志记录器接口
 */
export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, error?: Error): void;
}

// ============================================================================
// ❌ 错误示例：在内部创建依赖
// ============================================================================

/**
 * 反例：不要这样做！
 * 问题：在函数内部创建依赖，导致：
 * 1. 难以测试（无法 mock 依赖）
 * 2. 难以替换实现
 * 3. 违反依赖注入原则
 */
export const createAuthServiceBad = () => {
  // ❌ 错误：在内部硬编码创建依赖
  const userRepo = createUserRepository(); // 硬编码依赖 - 无法替换
  const hasher = createSimplePasswordHasher(); // 硬编码依赖 - 无法测试
  const tokenGen = createSimpleTokenGenerator(); // 硬编码依赖 - 紧耦合

  return {
    async login(credentials: LoginCredentials) {
      // 实现逻辑...
      // 由于依赖在内部创建，调用者无法控制或替换这些依赖
    },
  };
};

// ============================================================================
// ✅ 正确示例：通过参数注入依赖
// ============================================================================

/**
 * 正确：创建认证服务的工厂函数
 * 所有依赖通过参数注入
 */
export const createAuthService = ({
  userRepository,
  passwordHasher,
  tokenGenerator,
  logger,
}: {
  userRepository: UserRepository;
  passwordHasher: PasswordHasher;
  tokenGenerator: TokenGenerator;
  logger: Logger;
}) => {
  return {
    /**
     * 用户登录
     */
    async login(credentials: LoginCredentials): Promise<AuthToken> {
      logger.info('User login attempt', { email: credentials.email });

      // 查找用户
      const user = await userRepository.findByEmail(credentials.email);
      if (!user) {
        logger.error('User not found', new Error('Invalid credentials'));
        throw new Error('Invalid credentials');
      }

      // 验证密码（使用注入的 passwordHasher）
      const isValid = await passwordHasher.verify(
        credentials.password,
        user.id, // 假设密码哈希存储在 user.id 中
      );

      if (!isValid) {
        logger.error('Invalid password');
        throw new Error('Invalid credentials');
      }

      // 生成 token（使用注入的 tokenGenerator）
      const token = await tokenGenerator.generate(user.id);
      logger.info('User logged in successfully', { userId: user.id });

      return token;
    },

    /**
     * 验证 token
     */
    async verifyToken(token: string): Promise<User | null> {
      const userId = await tokenGenerator.verify(token);
      if (!userId) {
        return null;
      }

      return userRepository.findByEmail(userId);
    },
  };
};

// ============================================================================
// 依赖实现示例（可替换）
// ============================================================================

/**
 * 内存用户仓储实现（用于测试）
 */
export const createInMemoryUserRepository = (): UserRepository => {
  const users = new Map<string, User>();

  return {
    async findByEmail(email: string) {
      return users.get(email) ?? null;
    },
    async save(user: User) {
      users.set(user.email, user);
    },
  };
};

/**
 * 简单密码哈希实现（仅用于示例）
 */
export const createSimplePasswordHasher = (): PasswordHasher => {
  return {
    async hash(password: string) {
      return `hashed_${password}`;
    },
    async verify(password: string, hash: string) {
      return hash === `hashed_${password}`;
    },
  };
};

/**
 * 简单 Token 生成器实现
 */
export const createSimpleTokenGenerator = (): TokenGenerator => {
  return {
    async generate(userId: string) {
      return {
        token: `token_${userId}_${Date.now()}`,
        expiresAt: new Date(Date.now() + 3600000), // 1小时后过期
      };
    },
    async verify(token: string) {
      const match = token.match(/^token_(.+)_\d+$/);
      return match ? match[1] : null;
    },
  };
};

/**
 * 控制台日志记录器实现
 */
export const createConsoleLogger = (): Logger => {
  return {
    info(message: string, meta?: Record<string, unknown>) {
      console.log(`[INFO] ${message}`, meta);
    },
    error(message: string, error?: Error) {
      console.error(`[ERROR] ${message}`, error);
    },
  };
};

// ============================================================================
// 使用示例
// ============================================================================

/**
 * 示例：组装依赖并创建服务
 */
export const exampleUsage = async () => {
  // 1. 创建依赖实例
  const userRepo = createInMemoryUserRepository();
  const hasher = createSimplePasswordHasher();
  const tokenGen = createSimpleTokenGenerator();
  const logger = createConsoleLogger();

  // 2. 注入依赖创建服务
  const authService = createAuthService({
    userRepository: userRepo,
    passwordHasher: hasher,
    tokenGenerator: tokenGen,
    logger: logger,
  });

  // 3. 准备测试数据
  await userRepo.save({
    id: 'user1',
    email: 'test@example.com',
    name: 'Test User',
  });

  // 4. 使用服务
  try {
    const token = await authService.login({
      email: 'test@example.com',
      password: 'password123',
    });
    console.log('Login successful:', token);
  } catch (error) {
    console.error('Login failed:', error);
  }
};

// ============================================================================
// 测试示例：依赖注入的优势
// ============================================================================

/**
 * 示例：使用 mock 依赖进行单元测试
 */
export const testExample = async () => {
  // 创建 mock 依赖（用于测试）
  const mockUserRepo: UserRepository = {
    findByEmail: async (email) => ({
      id: 'test-user',
      email,
      name: 'Mock User',
    }),
    save: async () => {},
  };

  const mockHasher: PasswordHasher = {
    hash: async (pwd) => pwd,
    verify: async () => true, // 总是返回 true
  };

  const mockTokenGen: TokenGenerator = {
    generate: async (userId) => ({
      token: `mock-token-${userId}`,
      expiresAt: new Date(),
    }),
    verify: async () => 'test-user',
  };

  const mockLogger: Logger = {
    info: () => {},
    error: () => {},
  };

  // 使用 mock 依赖创建服务
  const authService = createAuthService({
    userRepository: mockUserRepo,
    passwordHasher: mockHasher,
    tokenGenerator: mockTokenGen,
    logger: mockLogger,
  });

  // 测试登录功能
  const token = await authService.login({
    email: 'test@example.com',
    password: 'any-password',
  });

  console.log('Test passed:', token.token === 'mock-token-test-user');
};


function createUserRepository() {
  throw new Error("Function not implemented.");
}
// ============================================================================
// 关键要点
// ============================================================================

/**
 * 依赖注入的优势：
 *
 * 1. ✅ 易于测试：可以轻松替换为 mock 实现
 * 2. ✅ 松耦合：服务不依赖具体实现，只依赖接口
 * 3. ✅ 易于替换：可以在不修改服务代码的情况下替换依赖
 * 4. ✅ 清晰的依赖关系：从函数签名就能看出所有依赖
 * 5. ✅ 避免全局状态：不使用全局变量或单例
 *
 * 依赖注入的原则：
 *
 * 1. 永远不在函数内部创建依赖
 * 2. 所有依赖通过参数传入
 * 3. 使用接口定义依赖契约
 * 4. 依赖的创建和组装在外部完成（组合根）
 */
