import { Injectable, NotFoundException, ConflictException, UnauthorizedException, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { LoginUserDto } from './dto/login-user.dto';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @Inject(JwtService)
    private readonly jwtService: JwtService,
  ) {}

  async create(createUserDto: CreateUserDto): Promise<User> {
    // Check if username already exists
    const existingUser = await this.usersRepository.findOne({
      where: { username: createUserDto.username }
    });

    if (existingUser) {
      throw new ConflictException('Username already exists');
    }

    // Hash the password
    const hashedPassword = await this.hashPassword(createUserDto.password);

    // Create and save the new user
    const user = this.usersRepository.create({
      ...createUserDto,
      password: hashedPassword,
    });

    return this.usersRepository.save(user);
  }

  async findAll(): Promise<User[]> {
    return this.usersRepository.find();
  }

  async findOne(id: string): Promise<User> {
    const user = await this.usersRepository.findOne({
      where: { id }
    });

    if (!user) {
      throw new NotFoundException(`User with ID "${id}" not found`);
    }

    return user;
  }

  async findByUsername(username: string): Promise<User | undefined> {
    return this.usersRepository.findOne({
      where: { username }
    });
  }

  async update(id: string, updateUserDto: UpdateUserDto): Promise<User> {
    const user = await this.findOne(id);

    // If username is being updated, check if it's already taken
    if (updateUserDto.username && updateUserDto.username !== user.username) {
      const existingUser = await this.findByUsername(updateUserDto.username);
      if (existingUser) {
        throw new ConflictException('Username already exists');
      }
    }

    // If password is being updated, hash it
    if (updateUserDto.password) {
      updateUserDto.password = await this.hashPassword(updateUserDto.password);
    }

    // Update and save the user
    Object.assign(user, updateUserDto);
    return this.usersRepository.save(user);
  }

  async remove(id: string): Promise<void> {
    const result = await this.usersRepository.delete(id);

    if (result.affected === 0) {
      throw new NotFoundException(`User with ID "${id}" not found`);
    }
  }

  async login(loginUserDto: LoginUserDto): Promise<{ access_token: string, user: Partial<User> }> {
    const { username, password } = loginUserDto;

    // Find the user by username
    const user = await this.findByUsername(username);
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Verify the password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Generate JWT token
    const payload = { sub: user.id, username: user.username, isAdmin: user.isAdmin };
    const token = this.jwtService.sign(payload);

    // Return the user without the password
    const { password: _, ...userWithoutPassword } = user;

    return {
      access_token: token,
      user: userWithoutPassword
    };
  }

  private async hashPassword(password: string): Promise<string> {
    const saltRounds = 10;
    return bcrypt.hash(password, saltRounds);
  }

  // Create admin user if it doesn't exist on application startup
  async createAdminUserIfNotExists(): Promise<void> {
    const adminUser = await this.usersRepository.findOne({
      where: { isAdmin: true }
    });

    if (!adminUser) {
      const password = 'admin123'; // Default admin password
      const hashedPassword = await this.hashPassword(password);
      
      const admin = this.usersRepository.create({
        username: 'admin',
        password: hashedPassword,
        isAdmin: true,
        shopName: 'Admin',
      });

      await this.usersRepository.save(admin);
      console.log('Admin user has been created with default credentials');
    }
  }
} 